import { identity, outbox, relay, type Subscription } from "@napplet/sdk";

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

export type RelationshipStatus = 'following' | 'muted' | 'pinned' | 'list';

export interface RadarActivity {
  id: string;
  noteId: string;
  label: string;
  summary: string;
  createdAt: number;
}

export interface RadarPerson {
  pubkey: string;
  name: string;
  handle: string;
  relayHint: string;
  relationship: RelationshipStatus;
  list: string;
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
  subs: Subscription[];
  notify(): void;
}

function rebuild(ctx: RadarContext): void {
  ctx.state.people = [...ctx.people.values()].sort((a, b) => b.recent.length - a.recent.length || a.name.localeCompare(b.name));
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
    const outboxSub = outbox.subscribe(filter, { strategy: 'outbox', live: false });
    outboxSub.on('event', (result) => handleEvent(result.event as NostrEvent));
    outboxSub.on('closed', handleEose);
    ctx.subs.push({ close: () => outboxSub.close() });
    return;
  }

  const sub = relay.subscribe(filter, (result) => handleEvent(result.event as NostrEvent), handleEose);
  ctx.subs.push(sub);
}

function applyProfile(ctx: RadarContext, event: NostrEvent): void {
  const person = ctx.people.get(event.pubkey);
  if (!person) return;
  try {
    const profile = JSON.parse(event.content) as ProfileContent;
    person.name = profile.display_name ?? profile.displayName ?? profile.name ?? person.name;
    person.handle = profile.nip05 ?? person.pubkey;
  } catch {
    // Ignore malformed profile JSON.
  }
}

function applyActivity(ctx: RadarContext, event: NostrEvent): void {
  const person = ctx.people.get(event.pubkey);
  if (!person || person.recent.some((item) => item.id === event.id)) return;
  person.recent = [{
    id: event.id,
    noteId: event.id,
    label: `kind ${event.kind}`,
    summary: summarize(event.content),
    createdAt: event.created_at,
  }, ...person.recent]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 8);
}

function seedPeople(ctx: RadarContext, self: string, pubkeys: string[], relayHint: string): void {
  for (const pubkey of pubkeys) {
    ctx.people.set(pubkey, {
      pubkey,
      name: pubkey === self ? 'You' : pubkey.slice(0, 12),
      handle: pubkey,
      relayHint,
      relationship: pubkey === self ? 'pinned' : 'following',
      list: pubkey === self ? 'Self' : 'Follows',
      recent: [],
    });
  }
}

async function load(ctx: RadarContext): Promise<void> {
  destroyRadar(ctx);
  ctx.people.clear();
  ctx.state.loading = true;
  ctx.state.error = null;
  rebuild(ctx);
  ctx.notify();

  try {
    const [self, follows, relays] = await Promise.all([
      identity.getPublicKey(),
      identity.getFollows().catch(() => []),
      identity.getRelays().catch(() => ({} as Record<string, { read: boolean; write: boolean }>)),
    ]);
    const pubkeys = Array.from(new Set([self, ...follows])).slice(0, 80);
    // relayHint is kept for DISPLAY/search only — the fetch path no longer
    // consumes it (the shell owns NIP-65 relay selection via outbox).
    const relayHint = Object.entries(relays).find(([, mode]) => mode.read)?.[0] ?? '';

    seedPeople(ctx, self, pubkeys, relayHint);
    rebuild(ctx);
    ctx.notify();

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
    subscribe(ctx, { kinds: [1], authors: pubkeys, limit: 160 }, (event) => applyActivity(ctx, event), useOutbox);
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
  const people = [...state.people].sort((a, b) => b.recent.length - a.recent.length || a.name.localeCompare(b.name));
  if (!q) return people;
  return people.filter((person) => [person.name, person.handle, person.relayHint, person.relationship, person.list]
    .join(' ')
    .toLowerCase()
    .includes(q));
}

export function selectedPerson(state: RadarState): RadarPerson | null {
  return state.people.find((person) => person.pubkey === state.selectedPubkey) ?? visiblePeople(state)[0] ?? null;
}

export function relationshipCounts(people: RadarPerson[]): Record<RelationshipStatus, number> {
  return people.reduce<Record<RelationshipStatus, number>>((counts, person) => {
    counts[person.relationship] += 1;
    return counts;
  }, { following: 0, muted: 0, pinned: 0, list: 0 });
}

export function latestActivity(person: RadarPerson): RadarActivity | null {
  return [...person.recent].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

function summarize(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return 'Empty note';
  return trimmed.length > 120 ? `${trimmed.slice(0, 120)}...` : trimmed;
}
