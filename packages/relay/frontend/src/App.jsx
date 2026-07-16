import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_MAX_PER_MESSAGE,
  AttachmentList,
  Avatar,
  Badge,
  ConfirmDialog,
  EmptyState,
  HelpModal,
  LiveDot,
  Modal,
  PaperclipIcon,
  PromptDialog,
  SettingsModal,
  Skeleton,
  StatChip,
  StatusDot,
  StatusMessage,
  TypingDots,
  Typewriter,
  clockTime,
  colorForAgent,
  colorForId,
  formatBytes,
  prefersReducedMotion,
  relativeTime,
} from "./components";
import SecurityScreen from "./SecurityScreen.jsx";
// The console's entire state/logic layer lives in consoleState.js (useConsoleState),
// shared with the Wire renderer. This file is the classic render layer only.
import {
  useConsoleState,
  channelGlyph,
  dayKey,
  dayDividerLabel,
  humanizeEvent,
  verificationOf,
  NEW_MESSAGE_MS,
  RAIL_TAB_LABELS,
} from "./consoleState.js";

export default function App() {
  const {
    // session + login
    session,
    formState,
    setFormState,
    loginStatus,
    loginTone,
    handleLoginSubmit,
    clearStoredSession,
    // fleet data
    overview,
    agents,
    agentsTotal,
    approvals,
    policies,
    deadLetters,
    deadLettersTotal,
    agentRateLimits,
    fleetHealth,
    attention,
    topology,
    activity,
    activityFilter,
    setActivityFilter,
    feeds,
    feedBusy,
    rooms,
    // selection
    selectedAgentId,
    selectedAgent,
    agentDetail,
    selectedConversationId,
    setSelectedConversationId,
    selectAgent,
    selectConversation,
    traceFromOps,
    backToList,
    returnFromTrace,
    traceReturn,
    // ui state
    agentStatusFilter,
    setAgentStatusFilter,
    agentSearch,
    setAgentSearch,
    rightTab,
    setRightTab,
    showSystem,
    setShowSystem,
    mobileView,
    opsOpen,
    setOpsOpen,
    leftCollapsed,
    rightCollapsed,
    toggleLeftRail,
    toggleRightRail,
    swipeBack,
    connStale,
    now,
    initialized,
    animatedIds,
    typingNow,
    // composer
    composerText,
    onComposerChange,
    onComposerKeyDown,
    syncMentionMenu,
    composerRecipient,
    setComposerRecipient,
    composerError,
    replyTarget,
    setReplyTarget,
    mentionMenu,
    setMentionMenu,
    chooseMention,
    mentionNames,
    handleSend,
    sending,
    composerInputRef,
    // attachments
    fileInputRef,
    pendingAttachments,
    uploading,
    dragActive,
    setDragActive,
    handleFilePick,
    handleComposerDrop,
    removePendingAttachment,
    // derived
    fleetCounts,
    healthyCount,
    conversationList,
    convTitle,
    nameFor,
    chatItems,
    typingAgents,
    recipientOptions,
    // refreshers
    refreshOverview,
    refreshAgents,
    refreshApprovals,
    refreshTimeline,
    handleApiError,
    // actions
    handleControl,
    handleApproval,
    handleSetTrust,
    trustPending,
    handleSetPeerAutoreply,
    peerPending,
    handleResumeConversation,
    resumePending,
    handleIssueToken,
    tokenStatus,
    tokenTone,
    // feeds
    handleCreateFeed,
    handlePollFeed,
    handleDeleteFeed,
    handleSetFeedSubscribers,
    // rooms
    roomModalOpen,
    setRoomModalOpen,
    roomSaving,
    handleCreateRoom,
    handleDeleteRoom,
    handleSetProjectMode,
    // policies
    policyModalOpen,
    setPolicyModalOpen,
    editingPolicy,
    policyForm,
    setPolicyForm,
    policyStatus,
    openPolicyCreate,
    openPolicyEdit,
    handlePolicySave,
    handlePolicyDelete,
    // dead letters
    expandedDeadLetter,
    handleExpandDeadLetter,
    // modals + settings
    modal,
    setModal,
    settings,
    updateSettings,
    settingsOpen,
    setSettingsOpen,
    helpOpen,
    setHelpOpen,
  } = useConsoleState();

  /* ---------------- login screen ---------------- */

  if (!session.token) {
    return (
      <div className="boot-screen">
        <form className="auth-card" onSubmit={handleLoginSubmit}>
          <div className="eyebrow auth-card__eyebrow">▸ Operator Terminal</div>
          <div className="auth-card__brand">
            <span className="brand-mark">E</span>
            <div>
              <div className="brand-name">Ekho</div>
              <div className="brand-sub">by Drakon Systems</div>
            </div>
          </div>
          <p className="auth-card__lede">Authenticate to monitor, steer, and message your private agent fleet.</p>
          <label className="field">
            <span>Fleet</span>
            <input value={formState.fleet_name} onChange={(e) => setFormState((v) => ({ ...v, fleet_name: e.target.value }))} autoComplete="off" />
          </label>
          <label className="field">
            <span>Email</span>
            <input type="email" value={formState.email} onChange={(e) => setFormState((v) => ({ ...v, email: e.target.value }))} autoComplete="username" />
          </label>
          <label className="field">
            <span>Password</span>
            <input type="password" value={formState.password} onChange={(e) => setFormState((v) => ({ ...v, password: e.target.value }))} autoComplete="current-password" />
          </label>
          <button className="button button--block" type="submit">Open console</button>
          <StatusMessage tone={loginTone}>{loginStatus}</StatusMessage>
        </form>
      </div>
    );
  }

  /* ---------------- main app shell ---------------- */

  return (
    <div className={`app app--${mobileView}${opsOpen ? " app--ops" : ""}`}>
      <header className="appbar grid-tex">
        <div className="appbar__brand">
          <span className="brand-mark">E</span>
          <div className="appbar__titles">
            <span className="brand-name">
              Ekho <span className="brand-by">by Drakon Systems</span>
            </span>
            <span className="appbar__sub">Operator Terminal · <span className="mono">{session.fleetId}</span></span>
          </div>
        </div>
        {/* Live fleet status line — colour-coded mono telemetry chips. */}
        <div className="appbar__hud" role="status" aria-label="Fleet status">
          <span className={`hud-chip ${fleetCounts.down ? "hud-chip--danger" : "hud-chip--ok"}`} title="Agents healthy (connection + model turns)">
            <span className="hud-chip__v mono">{healthyCount}/{fleetCounts.total}</span>
            <span className="hud-chip__l">healthy</span>
          </span>
          <span className={`hud-chip${overview.pendingApprovals ? " hud-chip--warn" : ""}`} title="Approvals awaiting decision">
            <span className="hud-chip__v mono">{overview.pendingApprovals || 0}</span>
            <span className="hud-chip__l">approvals</span>
          </span>
          <span className={`hud-chip${overview.deadLetterCount ? " hud-chip--danger" : ""}`} title="Undeliverable messages (dead-lettered)">
            <span className="hud-chip__v mono">{overview.deadLetterCount || 0}</span>
            <span className="hud-chip__l">dead-letter</span>
          </span>
        </div>
        <div className="appbar__right">
          <span
            className={`sync-pill${connStale ? " sync-pill--stale" : ""}`}
            title={connStale ? "Relay link degraded — retrying every 5s" : "Live — auto-syncing every 5s"}
          >
            <LiveDot active={!connStale} />
            {connStale ? "reconnecting…" : "live"}
          </span>
          <button className="icon-button appbar__icon" onClick={() => setSettingsOpen(true)} aria-label="Settings" title="Settings">
            <GearIcon />
          </button>
          <button className="icon-button appbar__icon" onClick={() => setHelpOpen(true)} aria-label="Help" title="Help & setup">
            <HelpIcon />
          </button>
          <button className="button button--sm" title="Open the Command Deck (full-screen HUD) in a new window" onClick={() => window.open("#deck", "_blank", "noopener")}>
            ◎ Deck
          </button>
          <button className="button button--ghost button--sm" onClick={() => Promise.all([refreshOverview(), refreshAgents(), refreshApprovals(), selectedConversationId ? refreshTimeline() : Promise.resolve()]).catch((e) => handleApiError(e, { allowSessionReset: true }))}>
            Refresh
          </button>
          <button className="button button--ghost button--sm" onClick={clearStoredSession}>Log out</button>
        </div>
      </header>

      <div className={`layout${leftCollapsed ? " layout--left-collapsed" : ""}${rightCollapsed ? " layout--right-collapsed" : ""}`}>
        {/* Re-open affordances — thin strips shown only when a rail is collapsed. */}
        <button className="rail-reopen rail-reopen--left" onClick={toggleLeftRail} aria-label="Expand fleet sidebar" title="Expand fleet">›</button>
        <button className="rail-reopen rail-reopen--right" onClick={toggleRightRail} aria-label="Expand operations rail" title="Expand operations">‹</button>
        {/* LEFT RAIL */}
        <aside className="rail rail--left">
          <div className="kpi-strip">
            <StatChip label="Agents" value={overview.agents?.length ?? 0} />
            <StatChip label="Healthy" value={healthyCount} tone="ok" />
            <StatChip label="Approvals" value={overview.pendingApprovals || 0} tone={overview.pendingApprovals ? "warn" : ""} />
            <StatChip label="Dead" value={overview.deadLetterCount || 0} tone={overview.deadLetterCount ? "danger" : ""} />
          </div>

          <div className="rail__section">
            <div className="rail__head">
              <span className="eyebrow">▸ Fleet</span>
              <span className="rail__count mono">{agentsTotal}</span>
            </div>
            <div className="rail__filters">
              <input className="rail__search" placeholder="Search agents" value={agentSearch} onChange={(e) => setAgentSearch(e.target.value)} />
              <select className="rail__statusfilter" value={agentStatusFilter} onChange={(e) => setAgentStatusFilter(e.target.value)}>
                <option value="all">All</option>
                <option value="healthy">Healthy</option>
                <option value="degraded">Degraded</option>
                <option value="paused">Paused</option>
                <option value="quarantined">Quarantined</option>
              </select>
            </div>
            <div className="rail__list">
              {!initialized.current.agents ? (
                <Skeleton count={5} height="52px" />
              ) : agents.length ? (
                agents.map((agent) => (
                  <button
                    key={agent.id}
                    className={`agent-row${agent.id === selectedAgentId ? " agent-row--active" : ""}`}
                    onClick={() => selectAgent(agent.id)}
                  >
                    <Avatar id={agent.id} label={agent.display_name || agent.id} size={34} />
                    <span className="agent-row__main">
                      <span className="agent-row__name">{agent.display_name || agent.id}</span>
                      <span className="agent-row__meta">
                        <span className="mono">{agent.runtime || "custom"}</span> · <span className="mono">{relativeTime(agent.last_seen_at)}</span>
                      </span>
                    </span>
                    <StatusDot status={agent.status} title={agent.status} />
                  </button>
                ))
              ) : (
                <EmptyState>No agents match.</EmptyState>
              )}
            </div>
          </div>

          <div className="rail__section rail__section--grow">
            <div className="rail__head">
              <span className="eyebrow">▸ Channels</span>
              <span className="rail__count mono">{conversationList.length}</span>
            </div>
            <div className="rail__list">
              {conversationList.length ? (
                conversationList.map((c) => {
                  const glyph = channelGlyph(c.id, rooms);
                  return (
                  <button
                    key={c.id}
                    className={`conv-row${c.id === selectedConversationId ? " conv-row--active" : ""}`}
                    onClick={() => selectConversation(c.id)}
                  >
                    <span className="conv-row__glyph" aria-hidden="true">{glyph}</span>
                    <span className="conv-row__dot" style={{ background: colorForId(c.id) }} />
                    <span className="conv-row__main">
                      <span className="conv-row__id">{c.title || convTitle(c.id)}</span>
                      <span className="conv-row__preview">{c.preview || "No signals yet"}</span>
                    </span>
                    {c.ts ? <span className="conv-row__time mono">{relativeTime(c.ts)}</span> : null}
                  </button>
                  );
                })
              ) : (
                <EmptyState>No channels yet — message the fleet to begin.</EmptyState>
              )}
            </div>
          </div>
        </aside>
        {/* Collapse handle — sits on the rail/center divider, revealed on rail hover. */}
        <button className="rail-collapse rail-collapse--left" onClick={toggleLeftRail} aria-label="Collapse fleet sidebar" title="Collapse fleet sidebar">‹</button>

        {/* CENTER — CHAT */}
        <main className="chat" {...swipeBack}>
          <div className="chat__header">
            <button className="chat__back" onClick={backToList} aria-label="Back to fleet">
              ‹ Fleet
            </button>
            {traceReturn && (
              <button
                className="chat__trace-return"
                onClick={returnFromTrace}
                aria-label={`Back to ${RAIL_TAB_LABELS[traceReturn] || traceReturn}`}
                title={`Back to ${RAIL_TAB_LABELS[traceReturn] || traceReturn}`}
              >
                ↩ {RAIL_TAB_LABELS[traceReturn] || traceReturn}
              </button>
            )}
            <div className="chat__heading">
              <span className="eyebrow chat__eyebrow">▸ Signal Log</span>
              {selectedConversationId ? (
                <>
                  <span className="conv-row__dot" style={{ background: colorForId(selectedConversationId) }} />
                  <span className="chat__convid">{convTitle(selectedConversationId)}</span>
                </>
              ) : (
                <span className="chat__placeholder-title">No channel selected</span>
              )}
            </div>
            <label className="toggle toggle--inline">
              <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
              <span>System events</span>
            </label>
            <button className="chat__ops" onClick={() => setOpsOpen(true)} aria-label="Open operations panel">
              Ops
            </button>
          </div>

          <ChatScroller
            items={chatItems}
            hasConversation={Boolean(selectedConversationId)}
            now={now}
            settings={settings}
            typingAgents={typingAgents}
            nameFor={nameFor}
            animatedIds={animatedIds}
            typingNow={typingNow}
            token={session.token}
            onReply={setReplyTarget}
            mentionNames={mentionNames}
            onResume={handleResumeConversation}
            resumePending={resumePending}
          />

          <div
            className={`composer${dragActive ? " composer--drag" : ""}`}
            onDragOver={(e) => {
              if (e.dataTransfer?.types?.includes("Files")) {
                e.preventDefault();
                if (!dragActive) setDragActive(true);
              }
            }}
            onDragLeave={(e) => {
              // only clear when leaving the composer itself, not its children
              if (e.currentTarget === e.target) setDragActive(false);
            }}
            onDrop={handleComposerDrop}
          >
            {dragActive ? <div className="composer__dropveil"><PaperclipIcon /> Drop files to attach</div> : null}

            {(pendingAttachments.length || uploading) ? (
              <div className="composer__attachments">
                {pendingAttachments.map((a) => (
                  <span className="att-pending" key={a.id} title={a.filename}>
                    <span className="att-pending__name">{a.filename}</span>
                    <span className="att-pending__size">{formatBytes(a.size_bytes)}</span>
                    <button
                      type="button"
                      className="att-pending__remove"
                      onClick={() => removePendingAttachment(a.id)}
                      aria-label={`Remove ${a.filename}`}
                    >
                      &times;
                    </button>
                  </span>
                ))}
                {uploading ? (
                  <span className="att-pending att-pending--uploading">
                    <span className="att-spinner" aria-hidden="true" />
                    <span className="att-pending__name">Uploading…</span>
                  </span>
                ) : null}
              </div>
            ) : null}

            {composerError ? <div className="composer__error">{composerError}</div> : null}

            {replyTarget ? (
              <div className="composer__reply">
                <span className="composer__reply-bar" aria-hidden="true" />
                <div className="composer__reply-body">
                  <span className="composer__reply-label">Replying to {replyTarget.label}</span>
                  <span className="composer__reply-text">{replyTarget.text}</span>
                </div>
                <button type="button" className="composer__reply-x" onClick={() => setReplyTarget(null)} aria-label="Cancel reply">✕</button>
              </div>
            ) : null}

            {mentionMenu ? (
              <div className="composer__mentions" role="listbox">
                {mentionMenu.items.map((a, i) => (
                  <button
                    key={a.agent_id}
                    type="button"
                    role="option"
                    aria-selected={i === mentionMenu.index}
                    className={`composer__mention${i === mentionMenu.index ? " composer__mention--active" : ""}`}
                    onMouseDown={(e) => { e.preventDefault(); chooseMention(a); }}
                  >
                    <span className="composer__mention-at">@</span>{a.display_name}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="composer__row">
              <select className="composer__recipient" value={composerRecipient} onChange={(e) => { const v = e.target.value; if (v === "__manage_rooms__") { setRoomModalOpen(true); return; } setComposerRecipient(v); if (v.startsWith("room:")) setSelectedConversationId(v.slice("room:".length)); }}>
                {recipientOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ATTACHMENT_ACCEPT}
                className="composer__file"
                onChange={handleFilePick}
                tabIndex={-1}
              />
              <button
                type="button"
                className="composer__attach"
                onClick={() => fileInputRef.current?.click()}
                disabled={pendingAttachments.length >= ATTACHMENT_MAX_PER_MESSAGE || uploading}
                title={pendingAttachments.length >= ATTACHMENT_MAX_PER_MESSAGE ? `Max ${ATTACHMENT_MAX_PER_MESSAGE} attachments` : "Attach files"}
                aria-label="Attach files"
              >
                <PaperclipIcon />
              </button>
              <textarea
                ref={composerInputRef}
                className="composer__input"
                placeholder="Message the fleet…  (@ to mention)"
                title="Enter to send · Shift+Enter for newline · @ to mention an agent"
                value={composerText}
                rows={1}
                onChange={onComposerChange}
                onClick={(e) => syncMentionMenu(e.target.value, e.target.selectionStart)}
                onBlur={() => requestAnimationFrame(() => setMentionMenu(null))}
                onKeyDown={onComposerKeyDown}
              />
              <button
                className="button composer__send"
                onClick={handleSend}
                disabled={!composerText.trim() || sending || uploading}
                title={!composerText.trim() && pendingAttachments.length ? "Add a message to send with your attachment" : undefined}
              >
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        </main>

        {/* RIGHT RAIL */}
        <div className="rail-backdrop" onClick={() => setOpsOpen(false)} aria-hidden="true" />
        <aside className="rail rail--right">
          <div className="rail__mobilebar">
            <span className="eyebrow">▸ Operations</span>
            <button className="icon-button" onClick={() => setOpsOpen(false)} aria-label="Close operations panel">✕</button>
          </div>
          <div className="tabs tabs--grouped">
            {[
              ["Monitor", [
                ["attention", `Needs You${attention.items.length ? ` (${attention.items.length})` : ""}`],
                ["health", "Health"],
                ["topology", "Map"],
                ["activity", "Activity"],
              ]],
              ["Control", [
                ["approvals", `Approvals${overview.pendingApprovals ? ` (${overview.pendingApprovals})` : ""}`],
                ["deadletters", "Dead"],
              ]],
              ["Configure", [
                ["feeds", "Feeds"],
                ["agent", "Agent"],
                ["access", "Access"],
                ["policies", "Policies"],
              ]],
              ["Security", [
                ["security", "🛡 Sec"],
              ]],
            ].map(([group, items]) => (
              <div className="tab-group" key={group}>
                <span className="tab-group__label">{group}</span>
                {items.map(([key, label]) => (
                  <button key={key} className={`tab${rightTab === key ? " tab--active" : ""}`} onClick={() => setRightTab(key)}>
                    {label}
                  </button>
                ))}
              </div>
            ))}
          </div>

          <div className="rail__scroll">
            {rightTab === "approvals" && (
              <ApprovalsTab
                approvals={approvals}
                initialized={initialized.current.approvals}
                onApprove={(id) => handleApproval(id, "approve")}
                onReject={(id) => handleApproval(id, "reject")}
                onTrace={traceFromOps}
              />
            )}

            {rightTab === "attention" && (
              <AttentionTab
                data={attention}
                initialized={initialized.current.attention}
                onSelectAgent={selectAgent}
                onOpenConversation={traceFromOps}
              />
            )}

            {rightTab === "health" && (
              <HealthTab agents={fleetHealth} initialized={initialized.current.health} />
            )}

            {rightTab === "topology" && (
              <TopologyTab data={topology} initialized={initialized.current.topology} onSelect={selectAgent} settings={settings} />
            )}

            {rightTab === "activity" && (
              <ActivityTab
                events={activity}
                agents={agents}
                initialized={initialized.current.activity}
                filter={activityFilter}
                onFilter={setActivityFilter}
                onOpenConversation={traceFromOps}
              />
            )}

            {rightTab === "security" && <SecurityScreen session={session} agents={agents} />}

            {rightTab === "feeds" && (
              <FeedsTab
                feeds={feeds}
                agents={agents}
                initialized={initialized.current.feeds}
                busy={feedBusy}
                onCreate={handleCreateFeed}
                onPoll={handlePollFeed}
                onDelete={handleDeleteFeed}
                onSetSubscribers={handleSetFeedSubscribers}
              />
            )}

            {rightTab === "agent" && (
              <AgentTab
                agent={selectedAgent}
                detail={agentDetail}
                rateLimits={agentRateLimits}
                onControl={handleControl}
                onTrace={traceFromOps}
              />
            )}

            {rightTab === "access" && (
              <AccessTab
                agents={agents}
                initialized={initialized.current.agents}
                trustPending={trustPending}
                onSetTrust={handleSetTrust}
                peerPending={peerPending}
                onSetPeerAutoreply={handleSetPeerAutoreply}
              />
            )}

            {rightTab === "deadletters" && (
              <DeadLettersTab
                deadLetters={deadLetters}
                total={deadLettersTotal}
                initialized={initialized.current.deadLetters}
                expanded={expandedDeadLetter}
                onExpand={handleExpandDeadLetter}
                onTrace={traceFromOps}
              />
            )}

            {rightTab === "policies" && (
              <PoliciesTab
                policies={policies}
                initialized={initialized.current.policies}
                onCreate={openPolicyCreate}
                onEdit={openPolicyEdit}
                onDelete={handlePolicyDelete}
              />
            )}
          </div>

          <div className="rail__foot">
            <button className="button button--ghost button--sm button--block" onClick={handleIssueToken}>Mint enrollment token</button>
            {tokenStatus ? (
              <div className={`token-out${tokenTone === "error" ? " token-out--error" : ""}`}>{tokenStatus}</div>
            ) : null}
            <button className="help-hint" onClick={() => setHelpOpen(true)}>Need help? Click the ? icon</button>
          </div>
        </aside>
        {/* Collapse handle — sits on the operations/center divider, revealed on rail hover. */}
        <button className="rail-collapse rail-collapse--right" onClick={toggleRightRail} aria-label="Collapse operations rail" title="Collapse operations rail">›</button>
      </div>

      {/* modals */}
      {modal?.type === "alert" && (
        <Modal title={modal.title} onClose={() => setModal(null)} actions={[{ label: "OK", onClick: () => setModal(null) }]}>
          <p style={{ margin: 0, lineHeight: 1.6 }}>{modal.message}</p>
        </Modal>
      )}
      {modal?.type === "confirm" && (
        <ConfirmDialog title={modal.title} message={modal.message} onConfirm={modal.onConfirm} onCancel={modal.onCancel} confirmLabel={modal.confirmLabel} confirmVariant={modal.confirmVariant} />
      )}
      {modal?.type === "prompt" && (
        <PromptDialog title={modal.title} message={modal.message} defaultValue={modal.defaultValue} onConfirm={modal.onConfirm} onCancel={modal.onCancel} />
      )}

      {policyModalOpen && (
        <PolicyModal
          editing={Boolean(editingPolicy)}
          form={policyForm}
          setForm={setPolicyForm}
          status={policyStatus}
          onClose={() => setPolicyModalOpen(false)}
          onSave={handlePolicySave}
        />
      )}

      {roomModalOpen && (
        <RoomModal
          agents={agents}
          rooms={rooms}
          saving={roomSaving}
          onCreate={handleCreateRoom}
          onDelete={handleDeleteRoom}
          onSetProjectMode={handleSetProjectMode}
          onClose={() => setRoomModalOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsModal agents={agents} settings={settings} onChange={updateSettings} onClose={() => setSettingsOpen(false)} />
      )}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

/* ---------------- header icons (inline SVG, no deps) ---------------- */

function GearIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

/* ============================ Chat scroller ============================ */

// WhatsApp-style delivery ticks on the operator's own messages, so per-recipient
// "delivered/acknowledged" receipts don't each take a whole bubble.
// Render message text with @handles that resolve to a real agent highlighted.
// `names` is a Set of lowercased display names; an @token not in it (e.g. an
// email's @host) stays plain text.
function MentionText({ text, names }) {
  const src = String(text ?? "");
  if (!names || names.size === 0) return src;
  const parts = src.split(/(@[\w-]+)/g);
  return (
    <>
      {parts.map((seg, i) =>
        /^@[\w-]+$/.test(seg) && names.has(seg.slice(1).toLowerCase())
          ? <span className="mention" key={i}>{seg}</span>
          : seg
      )}
    </>
  );
}

function DeliveryTicks({ status, deliveredN = 0, ackedN = 0 }) {
  const title =
    status === "pending" ? "Sending…"
    : status === "read" ? `Acknowledged${ackedN ? ` by ${ackedN}` : ""}`
    : status === "delivered" ? `Delivered${deliveredN ? ` to ${deliveredN}` : ""}${ackedN ? ` · read by ${ackedN}` : ""}`
    : "Sent";
  const single = status === "pending" || status === "sent";
  return (
    <span className={`ticks ticks--${status}`} title={title} aria-label={title}>
      {single ? "✓" : "✓✓"}
    </span>
  );
}

function ChatScroller({ items, hasConversation, now, settings, typingAgents, nameFor, animatedIds, typingNow, token, onReply, mentionNames, onResume, resumePending }) {
  const ref = useRef(null);
  const nearBottomRef = useRef(true);

  // track whether the user is near the bottom before the DOM updates
  const handleScroll = () => {
    const el = ref.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const stickToBottom = () => {
    const el = ref.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  };

  useLayoutEffect(() => {
    stickToBottom();
  }, [items.length, hasConversation, typingAgents.length]);

  if (!hasConversation) {
    return (
      <div className="chat__body chat__body--empty" ref={ref}>
        <EmptyState icon="▢" title="Select a channel to view its signal log">
          Pick a channel on the left, or message an agent below to open a new one. Your transmissions reach the agent’s inbox and stream back here live.
        </EmptyState>
      </div>
    );
  }

  if (!items.length && !typingAgents.length) {
    return (
      <div className="chat__body chat__body--empty" ref={ref}>
        <EmptyState icon="▢" title="No signals yet">Message the fleet to begin. Toggle system events to surface heartbeats and delivery receipts.</EmptyState>
      </div>
    );
  }

  const animate = settings.typingAnimation && !prefersReducedMotion();

  return (
    <div className="chat__body" ref={ref} onScroll={handleScroll}>
      {items.map((item, idx) => {
        const prev = items[idx - 1];
        const grouped = prev && prev.kind === item.kind && prev.side === item.side && prev.senderId === item.senderId;
        // A dated rule breaks the log into TODAY / YESTERDAY / "29 JUN" sections
        // so it never reads as an undifferentiated wall.
        const showDay = !prev || dayKey(prev.createdAt) !== dayKey(item.createdAt);
        const dayLabel = showDay ? dayDividerLabel(item.createdAt) : "";
        // Stable identity: the event id (server rows) or the optimistic id
        // (pending sends). Both are unique; idx is only a last-ditch fallback.
        const key = item.id || `${item.type}-${item.createdAt}-${idx}`;
        if (item.kind === "system") {
          const isStalled = item.variant === "stalled";
          // Offer Resume only while the stall is still "live": no operator
          // message or resume chip after it (either one re-opened the latch).
          const laterOperatorActivity = isStalled && items.slice(idx + 1).some(
            (x) => (x.kind === "message" && x.side === "operator") || x.variant === "resumed"
          );
          const text = isStalled
            ? `⏸ ${nameFor(item.senderId)} hit the agent-to-agent turn budget${item.stallBudget ? ` (${item.stallBudget})` : ""} — thread paused for them until you nudge or resume`
            : item.text;
          return (
            <React.Fragment key={key}>
              {dayLabel ? <div className="day-divider"><span>{dayLabel}</span></div> : null}
              <div className={`sys-chip${isStalled ? " sys-chip--stalled" : ""}${item.variant === "resumed" ? " sys-chip--resumed" : ""}`}>
                <span>{text}</span>
                {isStalled && !laterOperatorActivity && onResume ? (
                  <button
                    type="button"
                    className="sys-chip__resume"
                    disabled={resumePending}
                    onClick={onResume}
                    title="Send an operator nudge that gives every participant a fresh turn budget"
                  >
                    {resumePending ? "Resuming…" : "▶ Resume"}
                  </button>
                ) : null}
                <span className="sys-chip__time">{clockTime(item.createdAt)}</span>
              </div>
            </React.Fragment>
          );
        }
        const isOp = item.side === "operator";
        const isFeed = Boolean(item.feed);
        const label = isOp ? "Operator" : isFeed ? item.feedName : nameFor(item.senderId);
        const accent = isOp || isFeed ? null : colorForAgent(item.senderId, settings);
        // Agent→agent chatter: a message FROM an agent addressed to another agent
        // (recipient is an agent and not the synthetic operator). Highlighted
        // distinctly so peer coordination stands out from agent↔operator talk.
        const isPeer = item.side === "agent" && item.recipientKind === "agent"
          && item.recipientId && !String(item.recipientId).startsWith("op_");
        const verify = verificationOf(item);

        // Reveal a genuinely new agent message with the typewriter: not seen
        // before AND created within the freshness window (scrollback/history and
        // the operator's own sends render instantly). Once an id is "in flight"
        // it keeps typing across polls until the Typewriter signals completion —
        // so a background refresh never snaps a mid-animation message to full.
        const ts = new Date(item.createdAt).getTime();
        const isFresh = Number.isFinite(ts) && now - ts <= NEW_MESSAGE_MS;
        const id = item.messageId;
        const done = id && animatedIds.current.has(id);
        const inFlight = id && typingNow.current.has(id);
        // Feeds are a one-way news stream — render them instantly, never typed.
        const startNew = animate && !isOp && !isFeed && id && isFresh && !done && !inFlight && !item.pending;
        if (startNew) typingNow.current.add(id);
        const shouldType = animate && !isOp && !isFeed && id && !done && (inFlight || startNew);

        // Plain agent rows take their stable hash colour as the rail; peer/feed/
        // operator/system rails come from their kind class (--sig).
        const rowStyle = !isOp && !isFeed && !isPeer && accent ? { "--sig": accent } : undefined;
        const nameClass = isOp ? " bubble-meta__name--op" : isFeed ? " bubble-meta__name--feed" : "";
        const nameStyle = !isOp && !isFeed && accent ? { color: accent } : undefined;
        return (
          <React.Fragment key={key}>
            {dayLabel ? <div className="day-divider"><span>{dayLabel}</span></div> : null}
          <div className={`bubble-row${isOp ? " bubble-row--op" : ""}${isPeer ? " bubble-row--peer" : ""}${isFeed ? " bubble-row--feed" : ""}${grouped ? " bubble-row--grouped" : ""}`} style={rowStyle}>
            {!isOp && !grouped ? <Avatar id={isFeed ? "feed" : item.senderId} label={isFeed ? "📰" : label} size={30} color={accent || (isFeed ? "#fbbf24" : undefined)} /> : <span className="bubble-spacer" />}
            <div className="bubble-col">
              <div className="bubble-meta">
                {grouped ? <span className="bubble-meta__dot" aria-hidden="true" /> : null}
                <span className={`bubble-meta__name${nameClass}`} style={nameStyle}>{isFeed ? `📰 ${label}` : label}</span>
                {isFeed ? <span className="bubble-meta__broadcast">broadcast</span> : null}
                {isPeer ? <span className="bubble-meta__peer">→ {nameFor(item.recipientId)}</span> : null}
                <span className="bubble-meta__time">{clockTime(item.createdAt)}</span>
                {verify ? (
                  <span
                    className={`bubble-meta__verify${verify === "verified" ? " bubble-meta__verify--ok" : ""}`}
                    title={verify === "verified" ? "Operator-signed — cryptographically verified" : "Relay-attested delivery"}
                  >
                    {verify === "verified" ? "✓" : "·"}
                  </span>
                ) : null}
              </div>
              <div className={`bubble${isOp ? " bubble--op" : ""}${isPeer ? " bubble--peer" : ""}${isFeed ? " bubble--feed" : ""}${item.pending ? " bubble--pending" : ""}${item.text ? "" : " bubble--media"}`}>
                {item.text ? (
                  <div className="bubble__text">
                    {shouldType ? (
                      <Typewriter
                        text={item.text}
                        onTick={stickToBottom}
                        onDone={() => {
                          typingNow.current.delete(id);
                          animatedIds.current.add(id);
                        }}
                      />
                    ) : (
                      <MentionText text={item.text} names={mentionNames} />
                    )}
                  </div>
                ) : null}
                {item.attachments?.length ? (
                  <AttachmentList token={token} attachments={item.attachments} onImageLoad={stickToBottom} />
                ) : null}
                {isOp && item.status ? (
                  <div className="bubble__footer">
                    <DeliveryTicks status={item.status} deliveredN={item.deliveredN} ackedN={item.ackedN} />
                  </div>
                ) : null}
              </div>
            </div>
            {item.messageId ? (
              <button
                type="button"
                className="bubble-reply"
                title="Reply to this message"
                aria-label="Reply"
                onClick={() => onReply({ messageId: item.messageId, text: item.text || "(attachment)", label })}
              >
                ↩
              </button>
            ) : null}
          </div>
          </React.Fragment>
        );
      })}

      {/* live typing indicators — one bubble per agent currently owed a reply */}
      {typingAgents.map((t) => {
        const accent = colorForAgent(t.agentId, settings);
        return (
          <div className="bubble-row bubble-row--typing" key={`typing-${t.agentId}`} style={{ "--sig": accent }}>
            <Avatar id={t.agentId} label={t.label} size={30} color={accent} />
            <div className="bubble-col">
              <div className="bubble-meta">
                <span className="bubble-meta__name" style={{ color: accent }}>{t.label}</span>
                <span className="bubble-meta__time">typing…</span>
              </div>
              <div className="bubble bubble--typing">
                <TypingDots color={accent} animated={settings.typingAnimation} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ============================ Right-rail tabs ============================ */

function ApprovalsTab({ approvals, initialized, onApprove, onReject, onTrace }) {
  if (!initialized) return <Skeleton count={3} height="80px" />;
  if (!approvals.length) return <EmptyState title="Queue clear">No pending approvals.</EmptyState>;
  return (
    <div className="cards">
      {approvals.map((a) => (
        <article className="rcard" key={a.id}>
          <div className="rcard__head">
            <span className="rcard__title">{a.summary}</span>
            <Badge>{a.risk_level}</Badge>
          </div>
          <div className="rcard__meta">{a.display_name || a.agent_id} · {a.action_type}</div>
          <div className="rcard__meta mono">{relativeTime(a.requested_at)}</div>
          <div className="rcard__actions">
            <button className="button button--sm" onClick={() => onApprove(a.id)}>Approve</button>
            <button className="button button--sm button--danger" onClick={() => onReject(a.id)}>Reject</button>
            {a.conversation_id ? <button className="button button--sm button--ghost" onClick={() => onTrace(a.conversation_id)}>Trace</button> : null}
          </div>
        </article>
      ))}
    </div>
  );
}

function AgentTab({ agent, detail, rateLimits, onControl, onTrace }) {
  if (!agent) return <EmptyState title="No agent selected">Select an agent from the left rail to view controls, message history, and rate-limit activity.</EmptyState>;
  return (
    <div className="cards">
      <article className="rcard rcard--agent">
        <div className="rcard__agenthead">
          <Avatar id={agent.id} label={agent.display_name || agent.id} size={40} />
          <div>
            <div className="rcard__title">{agent.display_name || agent.id}</div>
            <div className="rcard__meta mono">{agent.id}</div>
          </div>
          <StatusDot status={agent.status} />
        </div>
        <div className="rcard__statline">
          <span><span className="mono">{agent.runtime || "custom"}</span></span>
          <span>seen {relativeTime(agent.last_seen_at)}</span>
        </div>
        <div className="rcard__actions">
          <button className="button button--sm button--warn" onClick={() => onControl(agent.id, "pause")}>Pause</button>
          <button className="button button--sm button--ghost" onClick={() => onControl(agent.id, "resume")}>Resume</button>
          <button className="button button--sm button--danger" onClick={() => onControl(agent.id, "quarantine")}>Quarantine</button>
        </div>
      </article>

      <div className="rsection-title">Recent messages</div>
      {detail?.recentMessages?.length ? (
        detail.recentMessages.slice(0, 8).map((m) => (
          <button className="line-row" key={m.id} onClick={() => onTrace(m.conversation_id)}>
            <span className="line-row__main">
              <span className="line-row__title">{m.message_type} <Badge>{m.status}</Badge></span>
              <span className="line-row__sub mono">{m.conversation_id}</span>
            </span>
            <span className="line-row__time">{relativeTime(m.created_at)}</span>
          </button>
        ))
      ) : (
        <div className="muted-note">No message history.</div>
      )}

      <div className="rsection-title">Rate-limit violations</div>
      {rateLimits.length ? (
        rateLimits.slice(0, 6).map((v) => (
          <div className="line-row line-row--static" key={v.id}>
            <span className="line-row__main">
              <span className="line-row__title">{v.message_count} / {v.limit_value} msgs</span>
              <span className="line-row__sub mono">{v.window_start}</span>
            </span>
            <Badge tone="warn">warn</Badge>
          </div>
        ))
      ) : (
        <div className="muted-note">No violations.</div>
      )}
    </div>
  );
}

function truncText(s, n) {
  if (typeof s !== "string") return String(s ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function FeedsTab({ feeds, agents, initialized, busy, onCreate, onPoll, onDelete, onSetSubscribers }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [subs, setSubs] = useState([]);
  const toggle = (id) => setSubs((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const submit = async () => {
    if (!name.trim() || !url.trim()) return;
    try {
      await onCreate({ name: name.trim(), url: url.trim(), subscriberAgentIds: subs });
      setName(""); setUrl(""); setSubs([]);
    } catch { /* error surfaced by parent */ }
  };

  // Editing the subscriber set of an already-saved feed.
  const [editingId, setEditingId] = useState(null);
  const [editSubs, setEditSubs] = useState([]);
  const startEdit = (f) => { setEditingId(f.id); setEditSubs((f.subscribers || []).map((s) => s.agent_id)); };
  const toggleEdit = (id) => setEditSubs((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const saveEdit = async (id) => {
    try { await onSetSubscribers(id, editSubs); setEditingId(null); } catch { /* surfaced by parent */ }
  };
  if (!initialized) return <Skeleton count={3} height="72px" />;
  return (
    <div className="cards">
      <div className="access-caption">
        Feeds (RSS/Atom) are polled and delivered to subscribed agents as <strong>non-waking</strong>
        {" "}context — they read them when active, spending no quota.
      </div>
      <div className="form">
        <label className="field"><span>Source name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Hacker News" /></label>
        <label className="field"><span>Feed URL (RSS / Atom)</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/feed" /></label>
        <div className="field">
          <span>Deliver to</span>
          <div className="room-members">
            {agents.length ? agents.map((a) => (
              <label className="room-member" key={a.id}>
                <input type="checkbox" checked={subs.includes(a.id)} onChange={() => toggle(a.id)} />
                <span>{a.display_name || a.id}</span>
              </label>
            )) : <span className="muted">No agents enrolled yet.</span>}
          </div>
        </div>
        <button
          className="button button--sm button--primary button--block"
          disabled={!name.trim() || !url.trim() || busy === "create"}
          onClick={submit}
        >
          {busy === "create" ? "Adding…" : "Add feed"}
        </button>
      </div>
      {feeds.length ? (
        <div className="feed-list">
          {feeds.map((f) => (
            <article className="rcard feed-row" key={f.id}>
              <div className="feed-row__head">
                <div className="feed-row__id">
                  <div className="rcard__title">{f.name}</div>
                  <div className="rcard__meta mono feed-row__url">{f.url}</div>
                </div>
                <div className="feed-row__actions">
                  <button
                    className={`button button--sm ${editingId === f.id ? "button--primary" : "button--ghost"}`}
                    onClick={() => (editingId === f.id ? setEditingId(null) : startEdit(f))}
                  >
                    Subscribers
                  </button>
                  <button className="button button--sm button--ghost" disabled={busy === f.id} onClick={() => onPoll(f.id)}>{busy === f.id ? "…" : "Poll"}</button>
                  <button className="button button--sm button--danger" onClick={() => onDelete(f.id)} aria-label="Delete feed">×</button>
                </div>
              </div>
              <div className="feed-row__stats">
                {f.subscribers?.length ?? 0} subscriber{(f.subscribers?.length ?? 0) === 1 ? "" : "s"} · {f.item_count ?? 0} items · {f.last_polled_at ? `polled ${relativeTime(f.last_polled_at)}` : "not polled yet"}
              </div>
              {editingId === f.id ? (
                <div className="feed-row__edit">
                  <div className="room-members">
                    {agents.length ? agents.map((a) => (
                      <label className="room-member" key={a.id}>
                        <input type="checkbox" checked={editSubs.includes(a.id)} onChange={() => toggleEdit(a.id)} />
                        <span>{a.display_name || a.id}</span>
                      </label>
                    )) : <span className="muted">No agents enrolled yet.</span>}
                  </div>
                  <div className="feed-row__edit-actions">
                    <button className="button button--sm button--ghost" onClick={() => setEditingId(null)}>Cancel</button>
                    <button
                      className="button button--sm button--primary"
                      disabled={busy === `subs-${f.id}`}
                      onClick={() => saveEdit(f.id)}
                    >
                      {busy === `subs-${f.id}` ? "Saving…" : "Save subscribers"}
                    </button>
                  </div>
                </div>
              ) : f.subscribers?.length ? (
                <div className="feed-row__subs">
                  {f.subscribers.map((s) => (
                    <span className="feed-sub-chip" key={s.agent_id}>{s.display_name || s.agent_id}</span>
                  ))}
                </div>
              ) : (
                <div className="feed-row__subs feed-row__subs--empty muted">No subscribers — add some so agents receive it.</div>
              )}
            </article>
          ))}
        </div>
      ) : (
        <EmptyState title="No feeds yet">Add a source above to keep your agents current.</EmptyState>
      )}
    </div>
  );
}

function formatActivity(e, nameOf) {
  const p = e.payload || {};
  const actor = e.actor_kind === "operator" ? "Operator" : e.actor_name || e.actor_id || "system";
  const target = e.resource_name || e.resource_id || "";
  switch (e.event_type) {
    case "message.queued": {
      let rcpt;
      if (p.recipient_kind === "broadcast") rcpt = "the fleet";
      else if (p.recipient_kind === "room") rcpt = "a room";
      else rcpt = nameOf(p.recipient_id) || "a teammate";
      const text = p.text ? ` — “${truncText(p.text, 90)}”` : "";
      return { who: actor, line: `→ ${rcpt} (${p.message_type || "msg"})${text}` };
    }
    case "agent.trust_changed":
      return { who: target, line: `operator trust ${p.operator_trusted ? "ON" : "OFF"}` };
    case "agent.peer_autoreply_changed":
      return { who: target, line: `delegation ${p.peer_autoreply ? `ON · budget ${p.peer_turn_budget}` : "OFF"}` };
    case "room.created": {
      const roomName = (typeof p.name === "string" && p.name.trim()) || target || "untitled";
      return { who: "Operator", line: `created room “${roomName}”${Array.isArray(p.members) ? ` · ${p.members.length} members` : ""}` };
    }
    case "room.deleted":
      return { who: "Operator", line: "deleted a room" };
    default:
      return { who: actor, line: humanizeEvent(e.event_type, p) };
  }
}

function ActivityTab({ events, agents, initialized, filter, onFilter, onOpenConversation }) {
  const nameMap = useMemo(() => {
    const m = new Map();
    (agents || []).forEach((a) => m.set(a.id, a.display_name || a.id));
    return m;
  }, [agents]);
  const nameOf = (id) => (id ? nameMap.get(id) || null : null);
  const filters = [["", "All"], ["message", "Messages"], ["room", "Rooms"], ["agent", "Changes"]];
  const [expanded, setExpanded] = useState(() => new Set());
  const toggle = (key) => setExpanded((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  // Consolidate the flat stream into a drill-down: one row per conversation (its
  // participants + latest activity), expandable to its events; non-conversation
  // events (trust/room/policy changes) collect under a "Fleet changes" group.
  const { convGroups, fleet } = useMemo(() => {
    const byConv = new Map();
    const fleetEvents = [];
    for (const e of events || []) {
      const actor = e.actor_kind === "operator" ? "Operator" : e.actor_name || nameOf(e.actor_id) || e.actor_id;
      if (e.conversation_id) {
        let g = byConv.get(e.conversation_id);
        if (!g) { g = { id: e.conversation_id, events: [], actors: new Set() }; byConv.set(e.conversation_id, g); }
        g.events.push(e);
        if (actor) g.actors.add(actor);
      } else {
        fleetEvents.push(e);
      }
    }
    const groups = [...byConv.values()].map((g) => ({
      ...g,
      latest: g.events[0],
      // headline the latest real message, not a delivery receipt
      latestMsg: g.events.find((e) => (e.event_type || "") === "message.queued") || g.events[0],
      count: g.events.length,
    }));
    groups.sort((a, b) => ((b.latest?.created_at || "") > (a.latest?.created_at || "") ? 1 : -1));
    return { convGroups: groups, fleet: fleetEvents };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, nameMap]);

  const eventRow = (e, size = 22) => {
    const { who, line } = formatActivity(e, nameOf);
    return (
      <div className="activity__row" key={e.id}>
        <Avatar id={e.actor_id || e.event_type} label={who} size={size} />
        <div className="activity__body">
          <div className="activity__line"><strong>{who}</strong> {line}</div>
          <div className="activity__time">{relativeTime(e.created_at)}</div>
        </div>
      </div>
    );
  };

  if (!initialized) return <Skeleton count={5} height="46px" />;
  return (
    <div className="activity">
      <div className="activity__filters">
        {filters.map(([val, label]) => (
          <button key={val || "all"} className={`chip${filter === val ? " chip--active" : ""}`} onClick={() => onFilter(val)}>{label}</button>
        ))}
      </div>
      {convGroups.length || fleet.length ? (
        <div className="actgroups">
          {convGroups.map((g) => {
            const open = expanded.has(g.id);
            const { who, line } = formatActivity(g.latestMsg, nameOf);
            const names = [...g.actors];
            const title = names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "") || "Conversation";
            return (
              <div className={`actgroup${open ? " actgroup--open" : ""}`} key={g.id}>
                <div className="actgroup__head">
                  <button className="actgroup__chev" onClick={() => toggle(g.id)} aria-expanded={open} aria-label={open ? "Collapse" : "Expand"}>›</button>
                  <button className="actgroup__main" onClick={() => onOpenConversation?.(g.id)} title="Open conversation">
                    <span className="conv-row__dot" style={{ background: colorForId(g.id) }} />
                    <span className="actgroup__text">
                      <span className="actgroup__title">{title}</span>
                      <span className="actgroup__preview"><strong>{who}</strong> {line}</span>
                    </span>
                    <span className="actgroup__meta">
                      <span className="actgroup__count">{g.count}</span>
                      <span className="actgroup__time">{relativeTime(g.latest?.created_at)}</span>
                    </span>
                  </button>
                </div>
                {open ? <div className="actgroup__events">{g.events.map((e) => eventRow(e))}</div> : null}
              </div>
            );
          })}
          {fleet.length ? (
            <div className={`actgroup${expanded.has("__fleet__") ? " actgroup--open" : ""}`}>
              <div className="actgroup__head">
                <button className="actgroup__chev" onClick={() => toggle("__fleet__")} aria-expanded={expanded.has("__fleet__")} aria-label="Toggle fleet changes">›</button>
                <button className="actgroup__main" onClick={() => toggle("__fleet__")}>
                  <span className="conv-row__dot" style={{ background: "var(--muted)" }} />
                  <span className="actgroup__text">
                    <span className="actgroup__title">Fleet changes</span>
                    <span className="actgroup__preview">trust, rooms, policies &amp; control</span>
                  </span>
                  <span className="actgroup__meta"><span className="actgroup__count">{fleet.length}</span></span>
                </button>
              </div>
              {expanded.has("__fleet__") ? <div className="actgroup__events">{fleet.map((e) => eventRow(e))}</div> : null}
            </div>
          ) : null}
        </div>
      ) : (
        <EmptyState title="No activity yet">Fleet messages, hand-offs, and changes will stream here.</EmptyState>
      )}
    </div>
  );
}

// The "Needs You" queue: the operator's single ranked to-do list of things
// that actually need a human — dead/degraded models, stalled hand-offs, and
// undeliverable messages. Empty = genuinely nothing on fire.
const ATTN_GLYPH = { agent_down: "⏻", agent_degraded: "▽", stalled: "⏸", dead_letter: "✉" };
const ATTN_TONE = { critical: "danger", warn: "warn" };

function AttentionTab({ data, initialized, onSelectAgent, onOpenConversation }) {
  if (!initialized) return <Skeleton count={3} height="64px" />;
  const items = data?.items || [];
  if (!items.length) {
    return <EmptyState title="All clear">Nothing needs you right now — no down agents, stalled hand-offs, or dropped messages.</EmptyState>;
  }
  const counts = data.counts || { critical: 0, warn: 0 };
  return (
    <div className="cards">
      <div className="health-summary">
        <StatChip label="Critical" value={counts.critical || 0} tone={counts.critical ? "danger" : "muted"} />
        <StatChip label="Warnings" value={counts.warn || 0} tone={counts.warn ? "warn" : "muted"} />
      </div>
      {items.map((it) => {
        const tone = ATTN_TONE[it.severity] || "muted";
        const clickable = Boolean(it.conversationId || it.agentId);
        const onClick = () => {
          if (it.conversationId) onOpenConversation?.(it.conversationId);
          else if (it.agentId) onSelectAgent?.(it.agentId);
        };
        return (
          <article
            className={`rcard attn-item attn-item--${tone}${clickable ? " attn-item--click" : ""}`}
            key={it.id}
            onClick={clickable ? onClick : undefined}
            role={clickable ? "button" : undefined}
            tabIndex={clickable ? 0 : undefined}
          >
            <div className="attn-item__head">
              <span className={`attn-item__glyph attn-item__glyph--${tone}`} aria-hidden="true">{ATTN_GLYPH[it.kind] || "•"}</span>
              <span className="attn-item__title">{it.title}</span>
              <Badge tone={tone}>{it.severity === "critical" ? "CRITICAL" : "WARN"}</Badge>
            </div>
            <div className="attn-item__detail">{it.detail}</div>
            <div className="attn-item__foot">
              <span className="mono muted">{it.kind.replace("_", " ")}</span>
              {it.at ? <span className="muted">· {relativeTime(it.at)}</span> : null}
              {clickable ? <span className="attn-item__cta">{it.conversationId ? "open thread ›" : "view agent ›"}</span> : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}

// Fleet-health verdict → visual tone. The verdict is computed server-side
// (deriveAgentHealth) combining connection liveness with the model's real
// turn outcomes, so a connected-but-brain-dead agent lands on "down", not "ok".
const HEALTH_TONE = { down: "danger", degraded: "warn", ok: "ok" };
const HEALTH_RANK = { down: 0, degraded: 1, ok: 2 };
const HEALTH_LABEL = { down: "DOWN", degraded: "DEGRADED", ok: "OK" };

// Defensive fallback for a relay that predates the verdict (old build): derive
// a coarse level from the raw fields so the board never renders blank.
function agentHealth(a) {
  if (a.health && a.health.level) return a.health;
  if (a.status === "quarantined" || a.status === "revoked") return { level: "down", reason: a.status };
  if ((a.consecutive_missed_heartbeats || 0) > 0 || !a.last_heartbeat_at) return { level: "degraded", reason: "missing heartbeats" };
  return { level: "ok", reason: "healthy" };
}

function HealthTab({ agents, initialized }) {
  if (!initialized) return <Skeleton count={3} height="80px" />;
  if (!agents.length) return <EmptyState title="No agents">Enroll an agent to see fleet health here.</EmptyState>;

  // Sort worst-first so anything needing attention sits at the top of the board.
  const ranked = [...agents].sort((x, y) => {
    const hx = agentHealth(x), hy = agentHealth(y);
    const d = (HEALTH_RANK[hx.level] ?? 3) - (HEALTH_RANK[hy.level] ?? 3);
    return d !== 0 ? d : String(x.display_name || x.id).localeCompare(String(y.display_name || y.id));
  });
  const counts = ranked.reduce((acc, a) => { acc[agentHealth(a).level] = (acc[agentHealth(a).level] || 0) + 1; return acc; }, {});

  return (
    <div className="cards">
      <div className="health-summary">
        <StatChip label="OK" value={counts.ok || 0} tone="ok" />
        <StatChip label="Degraded" value={counts.degraded || 0} tone="warn" />
        <StatChip label="Down" value={counts.down || 0} tone={counts.down ? "danger" : "muted"} />
      </div>
      {ranked.map((a) => {
        const h = agentHealth(a);
        const tone = HEALTH_TONE[h.level] || "muted";
        const model = a.metrics?.model;
        const provider = a.metrics?.provider;
        const turnHealth = a.metrics?.turn_health;
        const errs = Number(a.metrics?.model_errors_1h ?? 0) || 0;
        const active = a.active_conversations?.length || 0;
        return (
          <article className={`rcard health-row health-row--${tone}`} key={a.id}>
            <div className="access-row__head">
              <Avatar id={a.id} label={a.display_name || a.id} size={34} />
              <div className="access-row__id">
                <div className="rcard__title">{a.display_name || a.id}</div>
                <div className="rcard__meta">
                  <span className="mono">{a.runtime || "custom"}</span>
                  {model ? (
                    <> · <span className="mono">{model}</span>{provider ? <span className="muted"> ({provider})</span> : null}</>
                  ) : (
                    <span className="muted"> · model —</span>
                  )}
                </div>
              </div>
              <Badge tone={tone}>{HEALTH_LABEL[h.level] || "?"}</Badge>
            </div>
            {h.level !== "ok" && h.reason ? (
              <div className={`health-reason health-reason--${tone}`}>▸ {h.reason}</div>
            ) : null}
            <div className="health-row__stats">
              <span className="health-stat"><strong>{a.sent_1h ?? 0}</strong> sent</span>
              <span className="health-stat"><strong>{a.received_1h ?? 0}</strong> recv</span>
              <span className="muted">/1h</span>
              <span className="health-row__spacer" />
              <span className="health-stat">{active} active</span>
              <span className="muted">beat {relativeTime(a.last_heartbeat_at)}</span>
            </div>
            <div className="health-row__flags">
              {turnHealth ? (
                <Badge tone={turnHealth === "down" ? "danger" : turnHealth === "degraded" ? "warn" : "ok"}>
                  turns {turnHealth}{errs ? ` · ${errs} err/1h` : ""}
                </Badge>
              ) : (
                <Badge tone="muted" title="Agent plugin predates turn telemetry">turns —</Badge>
              )}
              {a.operator_trusted ? <Badge tone="ok">trusted</Badge> : null}
              {a.peer_autoreply ? <Badge>delegation · {a.peer_turn_budget}</Badge> : <Badge>solo</Badge>}
            </div>
          </article>
        );
      })}
    </div>
  );
}

// Health bucket for a node ring: red if quarantined/revoked, amber if it's
// missing heartbeats (or never sent one), green otherwise.
function topoHealth(a) {
  if (a.status === "quarantined" || a.status === "revoked") return "danger";
  if ((a.consecutive_missed_heartbeats || 0) > 0 || !a.last_heartbeat_at) return "warn";
  return "ok";
}
const topoInitials = (name) => String(name || "?").slice(0, 2).toUpperCase();

/* Fleet topology map: a radial collaboration graph. The relay sits at the hub;
   each agent is a node placed around it (initials inside, ring coloured by health,
   size by throughput). Lines between agents are who actually messaged whom in the
   window — thicker = more. Faint spokes anchor every agent to the hub so isolated
   ones still read. Pure SVG, no chart dependency. Hovering a node isolates its
   links; clicking focuses that agent. A roster below doubles as the label key. */
function TopologyTab({ data, initialized, onSelect, settings }) {
  const [hovered, setHovered] = useState("");
  const nodes = data?.nodes || [];
  const edges = data?.edges || [];

  // Stable radial layout keyed on the agent set, so polling updates counts/health
  // without the map jumping around. Start at the top, go clockwise.
  const W = 340;
  const CX = 170;
  const CY = 150;
  const RING = 112;
  const positions = useMemo(() => {
    const ids = nodes.map((n) => n.id).sort();
    const pos = new Map();
    const n = ids.length || 1;
    ids.forEach((id, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      pos.set(id, { x: CX + RING * Math.cos(angle), y: CY + RING * Math.sin(angle) });
    });
    return pos;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.map((n) => n.id).sort().join("|")]);

  const degree = useMemo(() => {
    const d = new Map();
    for (const e of edges) {
      d.set(e.source, (d.get(e.source) || 0) + e.count);
      d.set(e.target, (d.get(e.target) || 0) + e.count);
    }
    return d;
  }, [edges]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const adjacency = useMemo(() => {
    const m = new Map();
    for (const e of edges) {
      if (!m.has(e.source)) m.set(e.source, new Set());
      if (!m.has(e.target)) m.set(e.target, new Set());
      m.get(e.source).add(e.target);
      m.get(e.target).add(e.source);
    }
    return m;
  }, [edges]);
  // On hover, spotlight the agent AND its direct collaborators (so a lit link never
  // dead-ends at a dimmed node); everything else fades back.
  const incident = (id) => !hovered || hovered === id || Boolean(adjacency.get(hovered)?.has(id));
  const edgeLit = (e) => !hovered || e.source === hovered || e.target === hovered;

  // If the hovered agent leaves the node set (e.g. removed on a poll), its
  // onMouseLeave can never fire — clear the hover so the map doesn't stay dimmed.
  useEffect(() => {
    if (hovered && !byId.has(hovered)) setHovered("");
  }, [byId, hovered]);

  if (!initialized) return <Skeleton count={1} height="320px" />;
  if (!nodes.length) return <EmptyState title="No agents">Enroll agents to see the fleet map here.</EmptyState>;

  return (
    <div className="topo">
      <div className="access-caption">
        Who's working with whom — agent-to-agent message flow over the last {data.window_minutes || 60} min.
        Thicker links = more traffic; ring colour = health; size = throughput.
      </div>

      <svg className="topo-svg" viewBox={`0 0 ${W} 300`} role="img" aria-label="Fleet collaboration map">
        {/* faint hub spokes first, under everything */}
        {nodes.map((a) => {
          const p = positions.get(a.id);
          if (!p) return null;
          return (
            <line
              key={`spoke-${a.id}`}
              className="topo-spoke"
              x1={CX} y1={CY} x2={p.x} y2={p.y}
              style={{ opacity: incident(a.id) ? 0.5 : 0.12 }}
            />
          );
        })}

        {/* collaboration edges */}
        {edges.map((e) => {
          const s = positions.get(e.source);
          const t = positions.get(e.target);
          if (!s || !t) return null;
          const sa = byId.get(e.source);
          const ta = byId.get(e.target);
          return (
            <line
              key={`edge-${e.source}-${e.target}`}
              className="topo-edge"
              x1={s.x} y1={s.y} x2={t.x} y2={t.y}
              strokeWidth={1.2 + Math.min(e.count, 12) * 0.6}
              style={{ opacity: edgeLit(e) ? 0.85 : 0.1 }}
            >
              <title>{`${sa?.display_name || e.source} ↔ ${ta?.display_name || e.target} · ${e.count} msg${e.count === 1 ? "" : "s"}`}</title>
            </line>
          );
        })}

        {/* relay hub */}
        <g className="topo-hub">
          <circle cx={CX} cy={CY} r={22} />
          <text x={CX} y={CY} dy="0.35em" textAnchor="middle">EKHO</text>
        </g>

        {/* agent nodes */}
        {nodes.map((a) => {
          const p = positions.get(a.id);
          if (!p) return null;
          const tput = (a.sent_1h ?? 0) + (a.received_1h ?? 0);
          const r = 13 + Math.min(tput, 24) * 0.42;
          const health = topoHealth(a);
          return (
            <g
              key={`node-${a.id}`}
              className="topo-node"
              transform={`translate(${p.x}, ${p.y})`}
              style={{ opacity: incident(a.id) ? 1 : 0.28, cursor: "pointer" }}
              onMouseEnter={() => setHovered(a.id)}
              onMouseLeave={() => setHovered("")}
              onClick={() => onSelect?.(a.id)}
            >
              <circle className={`topo-node__ring topo-node__ring--${health}`} r={r} />
              <text className="topo-node__label" dy="0.35em" textAnchor="middle" style={{ fill: colorForAgent(a.id, settings) }}>
                {topoInitials(a.display_name || a.id)}
              </text>
              <title>{`${a.display_name || a.id} · ${a.runtime || "custom"}${a.metrics?.model ? ` · ${a.metrics.model}` : ""}\n${a.sent_1h ?? 0} sent / ${a.received_1h ?? 0} recv (1h)`}</title>
            </g>
          );
        })}
      </svg>

      <div className="topo-roster">
        {nodes.map((a) => {
          const links = degree.get(a.id) || 0;
          const health = topoHealth(a);
          return (
            <button
              key={`roster-${a.id}`}
              className={`topo-roster__row${hovered === a.id ? " is-hot" : ""}`}
              onMouseEnter={() => setHovered(a.id)}
              onMouseLeave={() => setHovered("")}
              onClick={() => onSelect?.(a.id)}
            >
              <span className={`topo-dot topo-dot--${health}`} />
              <span className="topo-roster__name">{a.display_name || a.id}</span>
              <span className="topo-roster__stat muted">{a.sent_1h ?? 0}↑ {a.received_1h ?? 0}↓</span>
              <span className="topo-roster__links">{links ? `${links} link${links === 1 ? "" : "s"}` : "idle"}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PeerControl({ agent, pending, onSet }) {
  const enabled = Boolean(agent.peer_autoreply);
  const savedBudget = agent.peer_turn_budget ?? 25;
  const [budget, setBudget] = useState(savedBudget);
  useEffect(() => { setBudget(savedBudget); }, [savedBudget]);

  const commitBudget = () => {
    const next = Math.max(1, Math.min(200, Math.trunc(Number(budget) || savedBudget)));
    setBudget(next);
    if (enabled && next !== savedBudget) onSet(agent.id, true, next);
  };

  return (
    <div className="access-row__peer">
      <label className={`toggle access-row__toggle${pending ? " access-row__toggle--pending" : ""}`}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={pending}
          onChange={(e) => onSet(agent.id, e.target.checked)}
        />
        <span>Agent-to-agent delegation</span>
        {pending ? <span className="access-row__spinner" aria-label="Saving" /> : null}
      </label>
      {enabled ? (
        <div className="access-row__budget">
          <span className="access-row__budget-label">Budget</span>
          <input
            className="access-row__budget-input"
            type="number"
            min={1}
            max={200}
            value={budget}
            disabled={pending}
            onChange={(e) => setBudget(e.target.value)}
            onBlur={commitBudget}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
          />
          <span className="access-row__budget-unit">turns / conversation</span>
        </div>
      ) : null}
    </div>
  );
}

function AccessTab({ agents, initialized, trustPending, onSetTrust, peerPending, onSetPeerAutoreply }) {
  if (!initialized) return <Skeleton count={3} height="64px" />;
  if (!agents.length) return <EmptyState title="No agents">Enroll an agent to grant it an operator-trusted channel.</EmptyState>;
  return (
    <div className="cards">
      <div className="access-caption">
        <strong>Operator-trusted channel:</strong> when ON, this agent recognizes the console operator as its verified principal (risky actions still require approval).<br />
        <strong>Agent-to-agent delegation:</strong> when ON, teammates can wake this agent to collaborate, bounded by the per-conversation turn budget.
      </div>
      {agents.map((agent) => {
        const trusted = Boolean(agent.operator_trusted);
        const pending = trustPending === agent.id;
        return (
          <article className="rcard access-row" key={agent.id}>
            <div className="access-row__head">
              <Avatar id={agent.id} label={agent.display_name || agent.id} size={34} />
              <div className="access-row__id">
                <div className="rcard__title">{agent.display_name || agent.id}</div>
                <div className="rcard__meta mono">{agent.id}</div>
              </div>
              <StatusDot status={agent.status} title={agent.status} />
            </div>
            <label className={`toggle access-row__toggle${pending ? " access-row__toggle--pending" : ""}`}>
              <input
                type="checkbox"
                checked={trusted}
                disabled={pending}
                onChange={(e) => onSetTrust(agent.id, e.target.checked)}
              />
              <span>Operator-trusted channel</span>
              {pending ? <span className="access-row__spinner" aria-label="Saving" /> : null}
            </label>
            <PeerControl agent={agent} pending={peerPending === agent.id} onSet={onSetPeerAutoreply} />
          </article>
        );
      })}
    </div>
  );
}

function DeadLettersTab({ deadLetters, total, initialized, expanded, onExpand, onTrace }) {
  if (!initialized) return <Skeleton count={3} height="70px" />;
  if (!deadLetters.length) return <EmptyState title="All delivered">No dead letters. Every message reached its recipient.</EmptyState>;
  return (
    <div className="cards">
      <div className="rsection-title">{total} dead letter{total === 1 ? "" : "s"}</div>
      {deadLetters.map((dl) => (
        <article className="rcard" key={dl.id}>
          <div className="rcard__head">
            <span className="rcard__title">{dl.message_type}</span>
            <Badge tone="warn">retry {dl.retry_count}</Badge>
          </div>
          <div className="rcard__meta mono">{dl.sender_agent_id} → {dl.recipient_agent_id}</div>
          <div className="rcard__meta">{dl.failure_reason} · {relativeTime(dl.dead_lettered_at)}</div>
          <div className="rcard__actions">
            <button className="button button--sm button--ghost" onClick={() => onExpand(dl)}>{expanded?.id === dl.id ? "Collapse" : "Expand"}</button>
            {dl.conversation_id ? <button className="button button--sm button--ghost" onClick={() => onTrace(dl.conversation_id)}>Trace</button> : null}
          </div>
          {expanded?.id === dl.id ? <pre className="code-block">{JSON.stringify(expanded, null, 2)}</pre> : null}
        </article>
      ))}
    </div>
  );
}

function PoliciesTab({ policies, initialized, onCreate, onEdit, onDelete }) {
  return (
    <div className="cards">
      <button className="button button--sm button--block" onClick={onCreate}>Create policy</button>
      {!initialized ? (
        <Skeleton count={2} height="70px" />
      ) : policies.length ? (
        policies.map((p) => {
          const rule = typeof p.rule_json === "string" ? JSON.parse(p.rule_json) : p.rule_json || {};
          return (
            <article className="rcard" key={p.id}>
              <div className="rcard__head">
                <span className="rcard__title">{p.name}</span>
                <Badge tone={p.enabled ? "ok" : ""}>{p.enabled ? "on" : "off"}</Badge>
              </div>
              <div className="rcard__meta">
                {p.scope_kind}{p.scope_id ? `: ${p.scope_id}` : ""} · <Badge>{rule?.action || "allow"}</Badge>
              </div>
              <div className="rcard__actions">
                <button className="button button--sm button--ghost" onClick={() => onEdit(p)}>Edit</button>
                <button className="button button--sm button--danger" onClick={() => onDelete(p.id)}>Delete</button>
              </div>
            </article>
          );
        })
      ) : (
        <EmptyState title="No policies">Create one to control message routing across the fleet.</EmptyState>
      )}
    </div>
  );
}

/** Per-room project-mode control: OFF by default; when ON the room carries its
 *  own (higher) agent-to-agent turn budget, so long working sessions don't
 *  stall on the per-agent default. */
function RoomProjectMode({ room, onSet }) {
  const saved = room.project_turn_budget ?? 100;
  const [budget, setBudget] = useState(saved);
  useEffect(() => { setBudget(saved); }, [saved, room.id]);
  const clamp = (v) => Math.max(1, Math.min(500, Math.trunc(Number(v) || saved)));
  return (
    <label className="room-project" title="Project mode: this room gets its own, higher agent-to-agent turn budget for long working sessions">
      <input
        type="checkbox"
        checked={Boolean(room.project_mode)}
        onChange={(e) => onSet(room.id, e.target.checked, clamp(budget))}
      />
      <span>Project mode</span>
      {room.project_mode ? (
        <input
          className="room-project__budget"
          type="number"
          min="1"
          max="500"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          onBlur={() => { const next = clamp(budget); setBudget(next); if (next !== saved) onSet(room.id, true, next); }}
          title="Turns each member may be woken by teammates in this room before pausing"
        />
      ) : null}
    </label>
  );
}

function RoomModal({ agents, rooms, saving, onCreate, onDelete, onSetProjectMode, onClose }) {
  const [name, setName] = useState("");
  const [memberIds, setMemberIds] = useState([]);
  const toggle = (id) =>
    setMemberIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const submit = () => {
    if (!name.trim()) return;
    onCreate(name.trim(), memberIds);
    setName("");
    setMemberIds([]);
  };
  return (
    <Modal
      title="Rooms"
      onClose={onClose}
      actions={[{ label: "Close", onClick: onClose, variant: "ghost" }]}
    >
      <div className="room-caption">
        A room is a named conversation with a chosen set of agents — message it to
        run a project with just those teammates instead of the whole fleet.
      </div>
      <div className="form">
        <label className="field">
          <span>New room name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. API Redesign" />
        </label>
        <div className="field">
          <span>Members</span>
          <div className="room-members">
            {agents.length ? (
              agents.map((a) => (
                <label className="room-member" key={a.id}>
                  <input type="checkbox" checked={memberIds.includes(a.id)} onChange={() => toggle(a.id)} />
                  <span>{a.display_name || a.id}</span>
                </label>
              ))
            ) : (
              <span className="muted">No agents enrolled yet.</span>
            )}
          </div>
        </div>
        <button
          className="button button--sm button--primary button--block"
          disabled={!name.trim() || saving}
          onClick={submit}
        >
          {saving ? "Creating…" : "Create room"}
        </button>
      </div>
      {rooms.length ? (
        <div className="room-list">
          {rooms.map((r) => (
            <div className="room-list__item" key={r.id}>
              <div className="room-list__meta">
                <strong># {r.name}</strong>
                <span className="muted"> · {r.members?.length ?? 0} member{(r.members?.length ?? 0) === 1 ? "" : "s"}</span>
                {r.project_mode ? <span className="room-list__project">project · {r.project_turn_budget}</span> : null}
              </div>
              <RoomProjectMode room={r} onSet={onSetProjectMode} />
              <button className="button button--sm button--danger" onClick={() => onDelete(r.id)}>Delete</button>
            </div>
          ))}
        </div>
      ) : null}
    </Modal>
  );
}

function PolicyModal({ editing, form, setForm, status, onClose, onSave }) {
  return (
    <Modal
      title={editing ? "Edit policy" : "Create policy"}
      onClose={onClose}
      actions={[
        { label: "Cancel", onClick: onClose, variant: "ghost" },
        { label: editing ? "Save changes" : "Create", onClick: onSave, variant: "primary" },
      ]}
    >
      <div className="form">
        <label className="field"><span>Name</span><input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></label>
        <label className="field">
          <span>Scope</span>
          <select value={form.scope_kind} onChange={(e) => setForm((f) => ({ ...f, scope_kind: e.target.value }))}>
            <option value="fleet">Fleet-wide</option>
            <option value="agent">Agent-specific</option>
          </select>
        </label>
        {form.scope_kind === "agent" && (
          <label className="field"><span>Scope agent ID</span><input value={form.scope_id} onChange={(e) => setForm((f) => ({ ...f, scope_id: e.target.value }))} placeholder="agent_…" /></label>
        )}
        <label className="field">
          <span>Action</span>
          <select value={form.rule.action} onChange={(e) => setForm((f) => ({ ...f, rule: { ...f.rule, action: e.target.value } }))}>
            <option value="deny">Deny</option>
            <option value="allow">Allow</option>
          </select>
        </label>
        <label className="field">
          <span>Message types (comma-separated)</span>
          <input
            value={(Array.isArray(form.rule.conditions.message_type) ? form.rule.conditions.message_type : []).join(", ")}
            onChange={(e) => {
              const types = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
              setForm((f) => ({ ...f, rule: { ...f.rule, conditions: { ...f.rule.conditions, message_type: types.length ? types : undefined } } }));
            }}
            placeholder="direct, broadcast, alert"
          />
        </label>
        <label className="field">
          <span>Sender agent IDs (comma-separated)</span>
          <input
            value={(Array.isArray(form.rule.conditions.sender_agent_id) ? form.rule.conditions.sender_agent_id : []).join(", ")}
            onChange={(e) => {
              const ids = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
              setForm((f) => ({ ...f, rule: { ...f.rule, conditions: { ...f.rule.conditions, sender_agent_id: ids.length ? ids : undefined } } }));
            }}
            placeholder="agent_…"
          />
        </label>
        <label className="toggle">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} />
          <span>Enabled</span>
        </label>
        {status ? <StatusMessage tone="error">{status}</StatusMessage> : null}
      </div>
    </Modal>
  );
}
