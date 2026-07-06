import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createInitialRadarState,
  createRadarStore,
  latestActivity,
  relationshipCounts,
  selectedPerson,
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
    handle: 'alice@example.com',
    relayHint: 'wss://relay.example',
    relationship: 'following',
    list: 'Follows',
    recent: [{ id: 'old', noteId: '1'.repeat(64), label: 'kind 1', summary: 'old', createdAt: 1 }],
  },
  {
    pubkey: 'b'.repeat(64),
    name: 'Bob',
    handle: 'bob@example.com',
    relayHint: '',
    relationship: 'pinned',
    list: 'Self',
    recent: [
      { id: 'old', noteId: '2'.repeat(64), label: 'kind 1', summary: 'old', createdAt: 1 },
      { id: 'new', noteId: '3'.repeat(64), label: 'kind 1', summary: 'new', createdAt: 2 },
    ],
  },
];

describe('people radar store (pure helpers)', () => {
  it('starts empty instead of loading deterministic people fixtures', () => {
    expect(createInitialRadarState().people).toEqual([]);
  });

  it('filters people by metadata and relay hints', () => {
    const state = { ...createInitialRadarState(), people, query: 'relay.example' };

    expect(visiblePeople(state)).toHaveLength(1);
    expect(visiblePeople(state)[0]!.name).toBe('Alice');
  });

  it('selects the requested person or first visible person', () => {
    const state = { ...createInitialRadarState(), people, selectedPubkey: people[1]!.pubkey };

    expect(selectedPerson(state)?.name).toBe('Bob');
  });

  it('counts relationship statuses', () => {
    const counts = relationshipCounts(people);

    expect(counts.following).toBe(1);
    expect(counts.pinned).toBe(1);
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

  it('still seeds relayHint onto people for display/search', async () => {
    installShell(true);

    const store = createRadarStore();
    store.load();
    await vi.waitFor(() => expect(mockOutboxQuery).toHaveBeenCalled());

    const follow = store.state.people.find((p) => p.pubkey === 'f1');
    expect(follow?.relayHint).toBe('wss://relay.example');
  });
});
