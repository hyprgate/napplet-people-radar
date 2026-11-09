<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { parseIntentResult, type IntentRequest } from '@hyprgate/types';
  import {
    invokeNappletIntent,
    createNoteViewerOpenIntentRequest,
    createNoteViewerOpenPayload,
    createProfileIntentRequest,
    pubkeyColorStyle,
    resourceImageBatch,
  } from '@hyprgate/utils';
  import {
    createRadarStore,
    latestActivity,
    radarSummary,
    selectedPerson,
    shortKey,
    timeAgo,
    visiblePeople,
    type RadarActivity,
    type RadarPerson,
    type RadarState,
  } from './lib/people-radar-store';

  let state = $state<RadarState>({ people: [], selectedPubkey: null, query: '', loading: true, error: null });
  const store = createRadarStore(() => {
    state = { ...store.state, people: [...store.state.people] };
  });
  const people = $derived(visiblePeople(state));
  /** The detail follows the filter, so it never shows someone the list has hidden. */
  const selected = $derived.by(() => {
    const person = selectedPerson(state);
    return person && people.some((entry) => entry.pubkey === person.pubkey) ? person : people[0] ?? null;
  });
  const summary = $derived(radarSummary(state.people));
  let showingDetail = $state(false);
  let navigationError = $state('');
  let backButton = $state<HTMLButtonElement | null>(null);
  let returnFocusTo: HTMLElement | null = null;

  onMount(() => {
    store.load();
    return () => store.destroy();
  });

  async function selectPerson(person: RadarPerson, event: MouseEvent): Promise<void> {
    store.select(person.pubkey);
    showingDetail = true;
    returnFocusTo = event.currentTarget as HTMLElement;
    await tick();
    // Only the narrow layout shows this button, and hidden elements can't take focus.
    backButton?.focus();
  }

  async function backToList(): Promise<void> {
    showingDetail = false;
    await tick();
    returnFocusTo?.focus();
  }

  function setQuery(value: string): void {
    store.setQuery(value);
    showingDetail = false;
  }

  function personKey(person: RadarPerson): string {
    return person.npub || person.pubkey;
  }

  async function invokeNavigation(request: IntentRequest | null, failure: string): Promise<void> {
    navigationError = '';
    if (!request) {
      navigationError = failure;
      return;
    }
    try {
      const result = parseIntentResult(await invokeNappletIntent(request));
      if (!result || result.ok) return;
      navigationError = result.error ?? failure;
    } catch {
      navigationError = failure;
    }
  }

  async function openProfile(person: RadarPerson): Promise<void> {
    await invokeNavigation(createProfileIntentRequest({ pubkey: person.pubkey }), `Couldn't open ${person.name}'s profile.`);
  }

  async function openNote(activity: RadarActivity | null): Promise<void> {
    if (!activity) return;
    const payload = createNoteViewerOpenPayload({
      target: { type: 'event', id: activity.noteId },
      source: { napplet: 'people-radar' },
      behavior: { focus: true, reuse: false },
    });
    await invokeNavigation(payload ? createNoteViewerOpenIntentRequest(payload, { behavior: payload.behavior }) : null, "Couldn't open that note.");
  }
</script>

{#snippet Avatar(person: RadarPerson)}
  <span class="avatar" aria-hidden="true">
    {person.name.slice(0, 1).toUpperCase()}
    {#if person.picture}<img use:resourceImageBatch={person.picture} alt="" />{/if}
  </span>
{/snippet}

<main class="radar-shell" data-view={showingDetail ? 'detail' : 'list'}>
  <header class="toolbar">
    <input aria-label="Search people" placeholder="Search names, keys and notes" value={state.query} oninput={(event) => setQuery(event.currentTarget.value)} />
    <span class="summary" role="status" data-testid="radar-summary">
      {#if state.query.trim()}
        {people.length} of {summary.people}
      {:else}
        {summary.people} {summary.people === 1 ? 'person' : 'people'}, {summary.active} recently active
      {/if}
    </span>
  </header>

  {#if navigationError}
    <p class="notice" role="alert" data-testid="radar-error">{navigationError}</p>
  {/if}

  <section class="content">
    <section class="people" aria-label="People">
      {#each people as person (person.pubkey)}
        {@const latest = latestActivity(person)}
        <div class="person-row" class:selected={selected?.pubkey === person.pubkey}>
          <button type="button" class="avatar-button" aria-label={`View ${person.name}'s profile`} title={`View ${person.name}'s profile`} onclick={() => openProfile(person)} data-testid="radar-avatar">
            {@render Avatar(person)}
          </button>
          <button
            type="button"
            class="person"
            aria-current={selected?.pubkey === person.pubkey ? 'true' : undefined}
            title={personKey(person)}
            data-pubkey={person.pubkey}
            onclick={(event) => selectPerson(person, event)}
          >
            <span class="identity">
              <span class="name" style={person.named ? pubkeyColorStyle(person.pubkey) : undefined}>{person.name}</span>
              {#if person.handle && person.handle !== person.name}<span class="handle">{person.handle}</span>{/if}
            </span>
            <span class="meta">
              {#if person.relationship === 'you'}<span class="you">You</span>{/if}
              <span>{latest ? `${person.recent.length} recent, ${timeAgo(latest.createdAt)}` : 'No recent notes'}</span>
            </span>
          </button>
        </div>
      {/each}
      {#if state.error}
        <p class="empty" role="alert">{state.error}</p>
      {:else if state.loading && people.length === 0}
        <p class="empty" role="status">Loading people…</p>
      {:else if people.length === 0 && state.query.trim()}
        <div class="empty centered" data-testid="radar-no-match">
          <strong>Nobody matches “{state.query.trim()}”</strong>
          <button type="button" onclick={() => setQuery('')}>Clear search</button>
        </div>
      {:else if people.length === 0}
        <p class="empty centered">Nobody here yet. Follow some people and they'll show up.</p>
      {/if}
    </section>

    <aside class="detail" aria-label="Selected person">
      {#if selected}
        {@const latest = latestActivity(selected)}
        <button type="button" class="back" bind:this={backButton} onclick={backToList} data-testid="radar-back">← All people</button>
        <button type="button" class="detail-identity" title={`View profile (${personKey(selected)})`} onclick={() => openProfile(selected)} data-testid="radar-open-profile">
          {@render Avatar(selected)}
          <span class="identity">
            <span class="detail-name" style={selected.named ? pubkeyColorStyle(selected.pubkey) : undefined}>{selected.name}</span>
            {#if selected.handle && selected.handle !== selected.name}<span class="handle">{selected.handle}</span>{/if}
            {#if selected.named}<span class="handle key">{shortKey(personKey(selected))}</span>{/if}
          </span>
        </button>
        <div class="actions">
          <button type="button" onclick={() => openProfile(selected)}>Profile</button>
          <button type="button" disabled={!latest} onclick={() => openNote(latest)}>Latest Note</button>
        </div>
        <div class="activity">
          {#each selected.recent as item (item.id)}
            <button type="button" class="activity-item" onclick={() => openNote(item)}>
              <span class="activity-meta">{item.label}, {timeAgo(item.createdAt)}</span>
              <span class="activity-text">{item.summary}</span>
            </button>
          {:else}
            <p class="empty">No recent notes found. That can just mean their relays didn't have any to hand.</p>
          {/each}
        </div>
      {:else if !state.loading}
        <p class="empty centered">Pick someone to see what they've been up to.</p>
      {/if}
    </aside>
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    background: var(--hg-bg-base);
    color: var(--hg-text-primary);
    font: 13px/1.4 var(--hg-font-body);
  }

  .radar-shell { height: 100vh; display: flex; flex-direction: column; }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    background: var(--hg-bg-surface);
    border-bottom: 1px solid var(--hg-border-default);
  }
  .toolbar input { flex: 1; min-width: 0; }
  .summary { color: var(--hg-text-muted); font-size: 12px; white-space: nowrap; }

  input, button {
    border: 1px solid var(--hg-border-default);
    border-radius: 6px;
    background: var(--hg-bg-surface);
    color: var(--hg-text-primary);
    font: inherit;
    padding: 6px 10px;
  }
  input::placeholder { color: var(--hg-text-muted); opacity: .75; }
  button { cursor: pointer; }
  button:disabled { cursor: default; opacity: .5; }
  button:hover:not(:disabled) { border-color: var(--hg-accent-primary); }
  input:focus, button:focus-visible { outline: 2px solid var(--hg-accent-primary); outline-offset: 1px; }

  .notice {
    margin: 0;
    padding: 6px 12px;
    color: var(--hg-accent-danger);
    background: color-mix(in srgb, var(--hg-accent-danger) 10%, var(--hg-bg-surface));
    border-bottom: 1px solid var(--hg-border-default);
  }

  .content { min-height: 0; flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, .8fr); }
  .people { overflow: auto; padding: 8px; }

  .person-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-radius: 6px;
  }
  .person-row:hover { background: color-mix(in srgb, var(--hg-accent-primary) 8%, transparent); }
  .person-row.selected { background: color-mix(in srgb, var(--hg-accent-primary) 16%, transparent); }

  .avatar-button { padding: 0; border: 0; border-radius: 4px; background: none; }
  .avatar {
    position: relative;
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    width: 32px;
    height: 32px;
    overflow: hidden;
    border: 1px solid var(--hg-border-default);
    border-radius: 4px;
    background: color-mix(in srgb, var(--hg-accent-primary) 22%, var(--hg-bg-elevated));
    font-weight: 700;
  }
  .avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }

  .person {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
    padding: 2px 0;
    border: 0;
    background: none;
    text-align: left;
  }
  .identity { display: grid; min-width: 0; }
  .name, .handle { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .name { font-weight: 600; }
  .handle { color: var(--hg-text-muted); font-size: 12px; }
  .key { font-size: 11px; }
  .meta { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; color: var(--hg-text-muted); font-size: 12px; white-space: nowrap; }
  .you { padding: 0 5px; border: 1px solid var(--hg-border-default); border-radius: 3px; color: var(--hg-text-primary); }

  .detail {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
    min-height: 0;
    padding: 14px;
    border-left: 1px solid var(--hg-border-default);
    background: var(--hg-bg-surface);
  }
  .back { display: none; align-self: flex-start; }
  .detail-identity { display: flex; align-items: center; gap: 10px; padding: 0; border: 0; background: none; text-align: left; }
  .detail-identity .avatar { width: 48px; height: 48px; font-size: 18px; }
  .detail-identity:hover .detail-name { text-decoration: underline; text-underline-offset: 2px; }
  .detail-name { overflow: hidden; font-size: 17px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }

  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .activity { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; overflow: auto; padding: 2px; }
  .activity-item { display: grid; gap: 2px; text-align: left; background: var(--hg-bg-base); }
  .activity-meta { color: var(--hg-text-muted); font-size: 11px; }
  .activity-text { overflow-wrap: anywhere; white-space: pre-wrap; }

  .empty { margin: 0; padding: 10px; color: var(--hg-text-muted); }
  .centered { display: grid; justify-items: center; gap: 10px; padding: 32px 16px; text-align: center; }
  .centered strong { color: var(--hg-text-primary); }

  @media (max-width: 760px) {
    .toolbar { flex-wrap: wrap; }
    .toolbar input { flex-basis: 100%; }
    .content { grid-template-columns: minmax(0, 1fr); }
    .radar-shell[data-view='list'] .detail { display: none; }
    .radar-shell[data-view='detail'] .people { display: none; }
    .detail { border-left: 0; }
    .back { display: block; }
  }
</style>
