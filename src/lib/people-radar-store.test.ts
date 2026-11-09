import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createInitialRadarState,
  createRadarStore,
  latestActivity,
  radarSummary,
  selectedPerson,
  timeAgo,
  visiblePeople,
  type RadarPerson,
} from './people-radar-store';

// ---- SDK mock --------------------------------------------------------------

vi.mock('@napplet/sdk', () => ({
  relay: {
    subscribe: vi.fn().mockReturnValue({ close: vi.fn() }),
  },
  outbox: {
    subscribe: vi.fn(),
    query: vi.fn(),
  },
  common: {
    encodeNip19: vi.fn(async ({ hex }: { hex: string }) => ({ ok: true, value: `npub1${hex}${'0'.repeat(20)}` })),
  },
  identity: {
    getPublicKey: vi.fn().mockResolvedValue('self'),
    getFollows: vi.fn().mockResolvedValue(['f1', 'f2']),
    getRelays: vi.fn().mockResolvedValue({ 'wss://relay.example': { read: true, write: true } }),
  },
}));

import { identity, outbox, relay } from '@napplet/sdk';

const mockRelaySubscribe = vi.mocked(relay.subscribe);
const mockOutboxSubscribe = vi.mocked(outbox.subscribe);
const mockOutboxQuery = vi.mocked(outbox.query);

function installShell(supportsOutbox: boolean): { supports: ReturnType<typeof vi.fn> } {
  const supports = vi.fn((domain: string) => (domain === 'outbox' ? supportsOutbox : false));
  (globalThis as unknown as { napplet: unknown }).napplet = {
    shell: {
      ready: vi.fn().mockResolvedValue({}),
      supports,
    },
  };
  return { supports };
}

// ---- Pure-function fixtures (unchanged behavior) ---------------------------

const people: RadarPerson[] = [
  {
    pubkey: 'a'.repeat(64),
    name: 'Alice',
    named: true,
    handle: 'alice@example.com',
    npub: 'npub1alice',
    picture: '',
    relationship: 'following',
    recent: [{ id: 'old', noteId: '1'.repeat(64), label: 'Note', summary: 'old', createdAt: 1 }],
  },
  {
    pubkey: 'b'.repeat(64),
    name: 'Bob',
    named: true,
    handle: 'bob@example.com',
    npub: 'npub1bob',
    picture: '',
    relationship: 'you',
    recent: [
      { id: 'old', noteId: '2'.repeat(64), label: 'Note', summary: 'old', createdAt: 1 },
      { id: 'new', noteId: '3'.repeat(64), label: 'Note', summary: 'new', createdAt: 2 },
    ],
  },
];

describe('people radar store (pure helpers)', () => {
  it('starts empty instead of loading deterministic people fixtures', () => {
    expect(createInitialRadarState().people).toEqual([]);
  });

  it('filters people by name, NIP-05, npub and what they posted', () => {
    for (const query of ['alice', 'alice@example', 'npub1alice']) {
      expect(visiblePeople({ ...createInitialRadarState(), people, query }).map((person) => person.name)).toEqual(['Alice']);
    }
    expect(visiblePeople({ ...createInitialRadarState(), people, query: 'new' }).map((person) => person.name)).toEqual(['Bob']);
    expect(visiblePeople({ ...createInitialRadarState(), people, query: 'nothing' })).toEqual([]);
  });

  it('puts the most recently active first, and people with no notes last', () => {
    const quiet = { ...people[0]!, pubkey: 'c'.repeat(64), name: 'Quiet', recent: [] };
    const state = { ...createInitialRadarState(), people: [quiet, people[0]!, { ...people[1]!, recent: [{ ...people[1]!.recent[0]!, createdAt: 5 }] }] };
    expect(visiblePeople(state).map((person) => person.name)).toEqual(['Bob', 'Alice', 'Quiet']);
  });

  it('selects the requested person or first visible person', () => {
    const state = { ...createInitialRadarState(), people, selectedPubkey: people[1]!.pubkey };

    expect(selectedPerson(state)?.name).toBe('Bob');
  });

  it('summarizes how many people there are and how many posted recently', () => {
    expect(radarSummary([...people, { ...people[0]!, pubkey: 'c'.repeat(64), recent: [] }])).toEqual({ people: 3, active: 2 });
  });

  it('says how long ago in short words', () => {
    expect(timeAgo(1_000, 1_030)).toBe('just now');
    expect(timeAgo(1_000, 1_600)).toBe('10m ago');
    expect(timeAgo(0, 7_200)).toBe('2h ago');
    expect(timeAgo(0, 172_800)).toBe('2d ago');
  });

  it('returns latest activity by timestamp', () => {
    expect(latestActivity(people[1]!)?.id).toBe('new');
  });
});

// ---- Outbox-gated fetch ----------------------------------------------------

describe('people radar store load() outbox gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRelaySubscribe.mockReturnValue({ close: vi.fn() });
    vi.mocked(identity.getPublicKey).mockResolvedValue('self');
    vi.mocked(identity.getFollows).mockResolvedValue(['f1', 'f2']);
    vi.mocked(identity.getRelays).mockResolvedValue({
      'wss://relay.example': { read: true, write: true },
    });
    mockOutboxQuery.mockResolvedValue({ events: [] });
  });

  afterEach(() => {
    delete (globalThis as unknown as { napplet?: unknown }).napplet;
  });

  it('fetches kind-0 and kind-1 via outbox.query when supported', async () => {
    installShell(true);

    const store = createRadarStore();
    store.load();
    await vi.waitFor(() => expect(mockOutboxQuery).toHaveBeenCalledTimes(2));

    const kind0Call = mockOutboxQuery.mock.calls.find((c) => {
      const f = Array.isArray(c[0]) ? c[0][0] : c[0];
      return (f as { kinds?: number[] })?.kinds?.includes(0);
    });
    const kind1Call = mockOutboxQuery.mock.calls.find((c) => {
      const f = Array.isArray(c[0]) ? c[0][0] : c[0];
      return (f as { kinds?: number[] })?.kinds?.includes(1);
    });
    expect(kind0Call).toBeDefined();
    expect(kind1Call).toBeDefined();

    // Fetch must NOT use relay.subscribe when outbox is supported.
    expect(mockRelaySubscribe).not.toHaveBeenCalled();
    expect(mockOutboxSubscribe).not.toHaveBeenCalled();
  });

  it('routes outbox query events through the same handlers and flips loading on completion', async () => {
    installShell(true);
    mockOutboxQuery.mockImplementation(async (filter) => {
      const f = Array.isArray(filter) ? filter[0] : filter;
      if ((f as { kinds?: number[] })?.kinds?.includes(0)) {
        return {
          events: [{
            event: {
              id: 'meta1',
              kind: 0,
              pubkey: 'f1',
              created_at: 10,
              tags: [],
              content: JSON.stringify({ name: 'Felix' }),
              sig: 'sig',
            },
          }],
        };
      }
      return { events: [] };
    });

    const store = createRadarStore();
    store.load();
    await vi.waitFor(() => expect(mockOutboxQuery).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(store.state.loading).toBe(false));
    expect(store.state.people.find((p) => p.pubkey === 'f1')?.name).toBe('Felix');
  });

  it('falls back to relay.subscribe when outbox is unsupported', async () => {
    installShell(false);

    const store = createRadarStore();
    store.load();
    await vi.waitFor(() => expect(mockRelaySubscribe).toHaveBeenCalledTimes(2));

    expect(mockOutboxQuery).not.toHaveBeenCalled();
    const kinds = mockRelaySubscribe.mock.calls.map((c) => {
      const f = Array.isArray(c[0]) ? c[0][0] : c[0];
      return (f as { kinds?: number[] })?.kinds?.[0];
    });
    expect(kinds).toContain(0);
    expect(kinds).toContain(1);
  });

  it('names a person from the newest kind 0, and uses the npub when there is none', async () => {
    installShell(true);
    const metadata = (id: string, createdAt: number, content: object) => ({
      event: { id, kind: 0, pubkey: 'f1', created_at: createdAt, tags: [], content: JSON.stringify(content), sig: 'sig' },
    });
    mockOutboxQuery.mockImplementation(async (filter) => {
      const f = Array.isArray(filter) ? filter[0] : filter;
      if (!(f as { kinds?: number[] })?.kinds?.includes(0)) return { events: [] };
      return {
        events: [
          metadata('new', 20, { display_name: 'Felix', nip05: 'felix@example.com', picture: 'https://media.example/felix.png' }),
          metadata('old', 10, { name: 'Old Felix' }),
        ],
      };
    });

    const store = createRadarStore();
    store.load();
    await vi.waitFor(() => expect(store.state.loading).toBe(false));
    await vi.waitFor(() => {
      const nameless = store.state.people.find((p) => p.pubkey === 'f2');
      expect(nameless?.named).toBe(false);
      expect(nameless?.name).toMatch(/^npub1f2/);
    });
    expect(store.state.people.find((p) => p.pubkey === 'f1')).toMatchObject({
      name: 'Felix',
      named: true,
      handle: 'felix@example.com',
      picture: 'https://media.example/felix.png',
    });
  });

  it('keeps everyone from a long follow list, with room for their notes in the query', async () => {
    installShell(true);
    const follows = Array.from({ length: 200 }, (_, index) => `follow-${index}`);
    vi.mocked(identity.getFollows).mockResolvedValue(follows);

    const store = createRadarStore();
    store.load();
    await vi.waitFor(() => expect(mockOutboxQuery).toHaveBeenCalledTimes(2));
    expect(store.state.people).toHaveLength(201);
    const notes = mockOutboxQuery.mock.calls.map((c) => c[0] as { kinds?: number[]; authors?: string[]; limit?: number })
      .find((f) => f.kinds?.includes(1));
    expect(notes?.authors).toHaveLength(201);
    expect(notes?.limit).toBe(1_608);
  });

  it('still lists people when the outbox query fails', async () => {
    installShell(true);
    mockOutboxQuery.mockRejectedValue(new Error('no relays'));

    const store = createRadarStore();
    store.load();
    await vi.waitFor(() => expect(store.state.loading).toBe(false));
    expect(store.state.people.map((p) => p.pubkey).sort()).toEqual(['f1', 'f2', 'self']);
    expect(store.state.error).toBeNull();
  });
});
