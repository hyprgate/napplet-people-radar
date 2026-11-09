import { common, identity, outbox, relay, type Subscription } from "@napplet/sdk";

/** Minimal shape of the shim-installed shell handshake we depend on. */
interface NappletShellHandle {
  ready(): Promise<unknown>;
  supports(domain: string, protocol?: string): boolean;
}

function getShell(): NappletShellHandle | null {
  return (globalThis as unknown as { napplet?: { shell?: NappletShellHandle } }).napplet?.shell ?? null;
}

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [key: `#${string}`]: string[] | undefined;
}

/** Enough for a busy poster not to crowd everyone else out of one shared query. */
const NOTES_PER_PERSON = 8;

export type RelationshipStatus = 'you' | 'following';

export interface RadarActivity {
  id: string;
  noteId: string;
  label: string;
  summary: string;
  createdAt: number;
}

export interface RadarPerson {
  pubkey: string;
  /** Best-effort label: profile name, then the short npub. */
  name: string;
  /** False until a profile gives this person a real name. */
  named: boolean;
  /** NIP-05 when the profile has one. */
  handle: string;
  npub: string;
  picture: string;
  relationship: RelationshipStatus;
  recent: RadarActivity[];
}

export interface RadarState {
  people: RadarPerson[];
  selectedPubkey: string | null;
  query: string;
  loading: boolean;
  error: string | null;
}

export interface RadarStore {
  state: RadarState;
  load(): void;
  setQuery(query: string): void;
  select(pubkey: string): void;
  destroy(): void;
}

interface ProfileContent {
  name?: string;
  display_name?: string;
  displayName?: string;
  nip05?: string;
  picture?: string;
}

export function createInitialRadarState(): RadarState {
  return {
    people: [],
    selectedPubkey: null,
    query: '',
    loading: false,
    error: null,
  };
}

interface RadarContext {
  state: RadarState;
  people: Map<string, RadarPerson>;
  profileTimes: Map<string, number>;
  subs: Subscription[];
  notify(): void;
}

/** Most recently active first; people with no notes last, by name. */
function byMostRecent(a: RadarPerson, b: RadarPerson): number {
  const latest = (person: RadarPerson) => person.recent[0]?.createdAt ?? 0;
  return latest(b) - latest(a) || a.name.localeCompare(b.name);
}

function rebuild(ctx: RadarContext): void {
  ctx.state.people = [...ctx.people.values()].sort(byMostRecent);
  if (!ctx.state.selectedPubkey || !ctx.people.has(ctx.state.selectedPubkey)) {
    ctx.state.selectedPubkey = ctx.state.people[0]?.pubkey ?? null;
  }
}

function destroyRadar(ctx: RadarContext): void {
  for (const sub of ctx.subs.splice(0)) sub.close();
}

function subscribe(
  ctx: RadarContext,
  filter: NostrFilter,
  onEvent: (event: NostrEvent) => void,
  useOutbox: boolean,
): void {
  const handleEvent = (event: NostrEvent): void => {
    onEvent(event);
    rebuild(ctx);
    ctx.notify();
  };
  const handleEose = (): void => {
    ctx.state.loading = false;
    rebuild(ctx);
    ctx.notify();
  };

  if (useOutbox) {
    // The shell owns NIP-65 relay selection; no relayHint needed on the fetch.
    let closed = false;
    void outbox.query(filter)
      .then((result) => {
        if (closed) return;
        for (const item of result.events) handleEvent(item.event as NostrEvent);
      })
      .catch(() => { /* an unreachable rail leaves people listed without activity */ })
      .finally(() => {
        if (!closed) handleEose();
      });
    ctx.subs.push({ close: () => { closed = true; } });
    return;
  }

  const sub = relay.subscribe(filter, (result) => handleEvent(result.event as NostrEvent), handleEose);
  ctx.subs.push(sub);
}

export function shortKey(key: string): string {
  return key.length > 18 ? `${key.slice(0, 10)}…${key.slice(-6)}` : key;
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function applyProfile(ctx: RadarContext, event: NostrEvent): void {
  const person = ctx.people.get(event.pubkey);
  if (!person || event.created_at < (ctx.profileTimes.get(event.pubkey) ?? 0)) return;
  try {
    const profile = JSON.parse(event.content) as ProfileContent;
    ctx.profileTimes.set(event.pubkey, event.created_at);
    const label = firstText(profile.display_name, profile.displayName, profile.name, profile.nip05);
    if (label) {
      person.name = label;
      person.named = true;
    }
    person.handle = firstText(profile.nip05);
    person.picture = firstText(profile.picture);
  } catch {
    // Ignore malformed profile JSON.
  }
}

/** Encoding is a host call, so people show up immediately and get their npub just after. */
function encodeNpubs(ctx: RadarContext, pubkeys: string[]): void {
  for (const pubkey of pubkeys) {
    void Promise.resolve(common.encodeNip19({ type: 'npub', hex: pubkey })).then((result) => {
      const person = ctx.people.get(pubkey);
      if (!person || !result?.ok || !result.value) return;
      person.npub = result.value;
      if (!person.named) person.name = shortKey(result.value);
      rebuild(ctx);
      ctx.notify();
    }).catch(() => { /* the short hex key stays usable */ });
  }
}

function applyActivity(ctx: RadarContext, event: NostrEvent): void {
  const person = ctx.people.get(event.pubkey);
  if (!person || person.recent.some((item) => item.id === event.id)) return;
  person.recent = [{
    id: event.id,
    noteId: event.id,
    label: 'Note',
    summary: summarize(event.content),
    createdAt: event.created_at,
  }, ...person.recent]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 8);
}

function seedPeople(ctx: RadarContext, self: string, pubkeys: string[]): void {
  for (const pubkey of pubkeys) {
    ctx.people.set(pubkey, {
      pubkey,
      name: shortKey(pubkey),
      named: false,
      handle: '',
      npub: '',
      picture: '',
      relationship: pubkey === self ? 'you' : 'following',
      recent: [],
    });
  }
}

async function load(ctx: RadarContext): Promise<void> {
  destroyRadar(ctx);
  ctx.people.clear();
  ctx.profileTimes.clear();
  ctx.state.loading = true;
  ctx.state.error = null;
  rebuild(ctx);
  ctx.notify();

  try {
    const [self, follows] = await Promise.all([
      identity.getPublicKey(),
      identity.getFollows().catch(() => []),
    ]);
    const pubkeys = Array.from(new Set([self, ...follows]));

    seedPeople(ctx, self, pubkeys);
    rebuild(ctx);
    ctx.notify();
    encodeNpubs(ctx, pubkeys);

    if (pubkeys.length === 0) {
      ctx.state.loading = false;
      ctx.notify();
      return;
    }

    // The supports() gate returns false until shell.init lands, so it MUST be
    // read after ready() — a synchronous module-load read would always be false.
    const shell = getShell();
    await shell?.ready();
    const useOutbox = shell?.supports('outbox') ?? false;

    subscribe(ctx, { kinds: [0], authors: pubkeys, limit: pubkeys.length }, (event) => applyProfile(ctx, event), useOutbox);
    subscribe(ctx, { kinds: [1], authors: pubkeys, limit: Math.max(160, pubkeys.length * NOTES_PER_PERSON) }, (event) => applyActivity(ctx, event), useOutbox);
  } catch (error) {
    ctx.state.loading = false;
    ctx.state.error = error instanceof Error ? error.message : 'Unable to load people.';
    ctx.notify();
  }
}

export function createRadarStore(onUpdate?: () => void): RadarStore {
  const ctx: RadarContext = {
    state: createInitialRadarState(),
    people: new Map<string, RadarPerson>(),
    profileTimes: new Map<string, number>(),
    subs: [],
    notify: () => onUpdate?.(),
  };

  return {
    state: ctx.state,
    load: () => { void load(ctx); },
    setQuery(query: string): void {
      ctx.state.query = query;
      ctx.notify();
    },
    select(pubkey: string): void {
      ctx.state.selectedPubkey = pubkey;
      ctx.notify();
    },
    destroy: () => destroyRadar(ctx),
  };
}

export function visiblePeople(state: RadarState): RadarPerson[] {
  const q = state.query.trim().toLowerCase();
  const people = [...state.people].sort(byMostRecent);
  if (!q) return people;
  return people.filter((person) => [person.name, person.handle, person.npub, person.pubkey, ...person.recent.map((item) => item.summary)]
    .join(' ')
    .toLowerCase()
    .includes(q));
}

export function selectedPerson(state: RadarState): RadarPerson | null {
  return state.people.find((person) => person.pubkey === state.selectedPubkey) ?? visiblePeople(state)[0] ?? null;
}

export function radarSummary(people: RadarPerson[]): { people: number; active: number } {
  return { people: people.length, active: people.filter((person) => person.recent.length > 0).length };
}

/** A short "how long ago". `createdAt` is in seconds. */
export function timeAgo(createdAt: number, nowSeconds = Math.floor(Date.now() / 1_000)): string {
  const seconds = Math.max(0, nowSeconds - createdAt);
  if (seconds < 60) return 'just now';
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function latestActivity(person: RadarPerson): RadarActivity | null {
  return [...person.recent].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

function summarize(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return 'Empty note';
  return trimmed.length > 120 ? `${trimmed.slice(0, 120)}...` : trimmed;
}
