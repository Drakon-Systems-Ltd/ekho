import React, { useEffect, useMemo, useState } from "react";
import {
  ApiError,
  clearSession,
  controlAgent,
  getAgentDetail,
  getAgents,
  getApprovals,
  getConversationEvents,
  getEvents,
  getOverview,
  issueEnrollmentToken,
  loadSession,
  login,
  resolveApproval,
  storeSession,
} from "./api";
import {
  Badge,
  EmptyState,
  EventFeed,
  FilterBar,
  FilterInput,
  FilterSelect,
  KpiCard,
  Panel,
  Pagination,
  StatusMessage,
  Timeline,
} from "./components";
import { useAutoRefresh, useQueryState } from "./hooks";

const POLL_INTERVAL_MS = 5000;

export default function App() {
  const [session, setSession] = useState(loadSession());
  const [pollingEnabled, setPollingEnabled] = useState(true);
  const [overview, setOverview] = useState({ agents: [], pendingApprovals: 0, queuedMessages: 0, recentEvents: [] });
  const [agents, setAgents] = useState([]);
  const [agentsTotal, setAgentsTotal] = useState(0);
  const [approvals, setApprovals] = useState([]);
  const [approvalsTotal, setApprovalsTotal] = useState(0);
  const [events, setEvents] = useState([]);
  const [eventsTotal, setEventsTotal] = useState(0);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [agentDetail, setAgentDetail] = useState(null);
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [timelineEvents, setTimelineEvents] = useState([]);
  const [timelineTotal, setTimelineTotal] = useState(0);
  const [loginStatus, setLoginStatus] = useState("");
  const [loginTone, setLoginTone] = useState("");
  const [tokenStatus, setTokenStatus] = useState("");
  const [tokenTone, setTokenTone] = useState("");
  const [lastUpdated, setLastUpdated] = useState("Not synced");
  const [formState, setFormState] = useState({
    fleet_name: "default",
    email: "admin@example.com",
    password: "changeme123",
  });
  const { query: agentsQuery, updateQuery: updateAgentsQuery } = useQueryState({
    text: "",
    status: "all",
    sortBy: "last_seen_at",
    sortOrder: "desc",
    page: 1,
    limit: 12,
  });
  const { query: approvalsQuery, updateQuery: updateApprovalsQuery } = useQueryState({
    text: "",
    risk: "all",
    dateFrom: "",
    dateTo: "",
    sortBy: "requested_at",
    sortOrder: "desc",
    page: 1,
    limit: 10,
  });
  const { query: eventsQuery, updateQuery: updateEventsQuery } = useQueryState({
    text: "",
    type: "all",
    dateFrom: "",
    dateTo: "",
    sortBy: "created_at",
    sortOrder: "desc",
    page: 1,
    limit: 15,
  });
  const { query: timelineQuery, updateQuery: updateTimelineQuery } = useQueryState({
    text: "",
    type: "all",
    dateFrom: "",
    dateTo: "",
    sortBy: "created_at",
    sortOrder: "asc",
    page: 1,
    limit: 25,
  });

  const healthyCount = useMemo(
    () => (overview.agents || []).filter((agent) => agent.status === "healthy").length,
    [overview.agents]
  );
  const eventTypeOptions = useMemo(() => {
    const values = Array.from(new Set((events || []).map((event) => event.event_type.split(".")[0])));
    return [{ value: "all", label: "All event types" }, ...values.map((value) => ({ value, label: value }))];
  }, [events]);
  const timelineTypeOptions = useMemo(() => {
    const values = Array.from(new Set((timelineEvents || []).map((event) => event.event_type.split(".")[0])));
    return [{ value: "all", label: "All timeline types" }, ...values.map((value) => ({ value, label: value }))];
  }, [timelineEvents]);

  function resetDashboard() {
    setOverview({ agents: [], pendingApprovals: 0, queuedMessages: 0, recentEvents: [] });
    setAgents([]);
    setAgentsTotal(0);
    setApprovals([]);
    setApprovalsTotal(0);
    setEvents([]);
    setEventsTotal(0);
    setSelectedAgentId("");
    setAgentDetail(null);
    setSelectedConversationId("");
    setTimelineEvents([]);
    setTimelineTotal(0);
    setLastUpdated("Not synced");
  }

  function clearStoredSession() {
    clearSession();
    setSession({ token: "", fleetId: "", email: "" });
    resetDashboard();
  }

  function handleApiError(error, { allowSessionReset = false } = {}) {
    if (allowSessionReset && error instanceof ApiError && error.status === 401) {
      clearStoredSession();
      setLoginTone("error");
      setLoginStatus("Session expired. Log in again.");
      return;
    }
    window.alert(error.message);
  }

  async function refreshDashboard({ silent = false } = {}) {
    if (!session.token) return;

    const [nextOverview, nextApprovals] = await Promise.all([
      getOverview(session.token),
      getApprovals(session.token, {
        search: approvalsQuery.text,
        risk: approvalsQuery.risk,
        dateFrom: approvalsQuery.dateFrom,
        dateTo: approvalsQuery.dateTo,
        sortBy: approvalsQuery.sortBy,
        sortOrder: approvalsQuery.sortOrder,
        page: String(approvalsQuery.page),
        limit: String(approvalsQuery.limit),
      }),
    ]);

    setOverview(nextOverview);
    setApprovals(nextApprovals.approvals || []);
    setApprovalsTotal(nextApprovals.total || 0);
    setLastUpdated(`Synced ${new Date().toLocaleTimeString()}`);

    if (!silent) {
      setLoginTone("ok");
      setLoginStatus("Console synced.");
    }
  }

  async function refreshAgents() {
    if (!session.token) return;
    const result = await getAgents(session.token, {
      search: agentsQuery.text,
      status: agentsQuery.status,
      sortBy: agentsQuery.sortBy,
      sortOrder: agentsQuery.sortOrder,
      page: String(agentsQuery.page),
      limit: String(agentsQuery.limit),
    });
    setAgents(result.agents || []);
    setAgentsTotal(result.total || 0);
  }

  async function refreshEvents() {
    if (!session.token) return;
    const result = await getEvents(session.token, {
      search: eventsQuery.text,
      type: eventsQuery.type,
      dateFrom: eventsQuery.dateFrom,
      dateTo: eventsQuery.dateTo,
      sortBy: eventsQuery.sortBy,
      sortOrder: eventsQuery.sortOrder,
      page: String(eventsQuery.page),
      limit: String(eventsQuery.limit),
    });
    setEvents(result.events || []);
    setEventsTotal(result.total || 0);
  }

  async function refreshTimeline(conversationId = selectedConversationId) {
    if (!session.token || !conversationId) return;
    const result = await getConversationEvents(session.token, conversationId, {
      search: timelineQuery.text,
      type: timelineQuery.type,
      dateFrom: timelineQuery.dateFrom,
      dateTo: timelineQuery.dateTo,
      sortBy: timelineQuery.sortBy,
      sortOrder: timelineQuery.sortOrder,
      page: String(timelineQuery.page),
      limit: String(timelineQuery.limit),
    });
    setTimelineEvents(result.events || []);
    setTimelineTotal(result.total || 0);
  }

  async function handleLoginSubmit(event) {
    event.preventDefault();
    setLoginTone("");
    setLoginStatus("Opening console...");

    try {
      const response = await login(formState);
      const nextSession = {
        token: response.token,
        fleetId: response.fleet_id,
        email: formState.email,
      };
      storeSession(nextSession);
      setSession(nextSession);
      setLoginTone("ok");
      setLoginStatus("Console connected.");
    } catch (error) {
      setLoginTone("error");
      setLoginStatus(`Login failed: ${error.message}`);
    }
  }

  async function handleIssueToken() {
    if (!session.token) {
      setTokenTone("error");
      setTokenStatus("Log in before issuing enrollment tokens.");
      return;
    }

    setTokenTone("");
    setTokenStatus("Issuing token...");
    try {
      const response = await issueEnrollmentToken(session.token);
      setTokenTone("ok");
      setTokenStatus(`Enrollment token: ${response.token}`);
    } catch (error) {
      setTokenTone("error");
      setTokenStatus(`Token issue failed: ${error.message}`);
    }
  }

  async function handleControl(agentId, action) {
    const reason = window.prompt(`Reason for ${action} on ${agentId}:`, `Operator ${action}`);
    if (!reason) return;
    await controlAgent(session.token, agentId, action, { reason });
    await refreshDashboard({ silent: true });
  }

  async function handleApproval(approvalId, decision) {
    await resolveApproval(session.token, approvalId, decision);
    await refreshDashboard({ silent: true });
  }

  async function selectAgent(agentId) {
    setSelectedAgentId(agentId);
    setAgentDetail(await getAgentDetail(session.token, agentId));
  }

  async function selectConversation(conversationId) {
    if (!conversationId) return;
    setSelectedConversationId(conversationId);
    updateTimelineQuery({ page: 1 });
  }

  useEffect(() => {
    if (!session.token) return;
    refreshDashboard({ silent: true }).catch((error) => handleApiError(error, { allowSessionReset: true }));
  }, [session.token]);

  useEffect(() => {
    if (!session.token) return;
    refreshAgents().catch((error) => handleApiError(error, { allowSessionReset: true }));
  }, [session.token, agentsQuery.text, agentsQuery.status, agentsQuery.sortBy, agentsQuery.sortOrder, agentsQuery.page, agentsQuery.limit]);

  useEffect(() => {
    if (!session.token) return;
    refreshDashboard({ silent: true }).catch((error) => handleApiError(error, { allowSessionReset: true }));
  }, [
    session.token,
    approvalsQuery.text,
    approvalsQuery.risk,
    approvalsQuery.dateFrom,
    approvalsQuery.dateTo,
    approvalsQuery.sortBy,
    approvalsQuery.sortOrder,
    approvalsQuery.page,
    approvalsQuery.limit,
  ]);

  useEffect(() => {
    if (!session.token) return;
    refreshEvents().catch((error) => handleApiError(error, { allowSessionReset: true }));
  }, [session.token, eventsQuery.text, eventsQuery.type, eventsQuery.dateFrom, eventsQuery.dateTo, eventsQuery.sortBy, eventsQuery.sortOrder, eventsQuery.page, eventsQuery.limit]);

  useEffect(() => {
    if (!session.token || !selectedConversationId) return;
    refreshTimeline(selectedConversationId).catch((error) => handleApiError(error, { allowSessionReset: true }));
  }, [session.token, selectedConversationId, timelineQuery.text, timelineQuery.type, timelineQuery.dateFrom, timelineQuery.dateTo, timelineQuery.sortBy, timelineQuery.sortOrder, timelineQuery.page, timelineQuery.limit]);

  useEffect(() => {
    if (!session.token || !selectedAgentId) return;
    getAgentDetail(session.token, selectedAgentId)
      .then(setAgentDetail)
      .catch((error) => handleApiError(error, { allowSessionReset: true }));
  }, [session.token, selectedAgentId, overview.pendingApprovals, overview.queuedMessages, overview.recentEvents]);

  useAutoRefresh(
    Boolean(session.token && pollingEnabled),
    POLL_INTERVAL_MS,
    () => {
      Promise.all([
        refreshDashboard({ silent: true }),
        refreshAgents(),
        refreshEvents(),
        selectedConversationId ? refreshTimeline(selectedConversationId) : Promise.resolve(),
      ]).catch((error) => handleApiError(error, { allowSessionReset: true }));
    },
    [
      session.token,
      selectedAgentId,
      selectedConversationId,
      agentsQuery.text,
      agentsQuery.status,
      agentsQuery.sortBy,
      agentsQuery.sortOrder,
      agentsQuery.page,
      agentsQuery.limit,
      approvalsQuery.text,
      approvalsQuery.risk,
      approvalsQuery.dateFrom,
      approvalsQuery.dateTo,
      approvalsQuery.sortBy,
      approvalsQuery.sortOrder,
      approvalsQuery.page,
      approvalsQuery.limit,
      eventsQuery.text,
      eventsQuery.type,
      eventsQuery.dateFrom,
      eventsQuery.dateTo,
      eventsQuery.sortBy,
      eventsQuery.sortOrder,
      eventsQuery.page,
      eventsQuery.limit,
      timelineQuery.text,
      timelineQuery.type,
      timelineQuery.dateFrom,
      timelineQuery.dateTo,
      timelineQuery.sortBy,
      timelineQuery.sortOrder,
      timelineQuery.page,
      timelineQuery.limit,
    ]
  );

  return (
    <div className="console-shell">
      <header className="topbar">
        <div className="topbar__brand">
          <div className="brand-mark">Ekho</div>
          <div>
            <h1>Operator Console</h1>
            <p>Private fleet control, live monitoring, and intervention for distributed agents.</p>
          </div>
        </div>

        <div className="topbar__actions">
          <div className="session-pill">{session.token ? "Signed In" : "Signed Out"}</div>
          <button className="button button--ghost" onClick={() => refreshDashboard().catch((error) => handleApiError(error, { allowSessionReset: true }))}>
            Refresh
          </button>
          <button className="button button--ghost" onClick={() => setPollingEnabled((value) => !value)}>
            Auto Refresh: {pollingEnabled ? "On" : "Off"}
          </button>
          {session.token ? (
            <button className="button button--ghost" onClick={clearStoredSession}>
              Log Out
            </button>
          ) : null}
        </div>
      </header>

      <div className="console-layout">
        <aside className="sidebar stack">
          <Panel title="Session" meta={session.token ? `${session.email} · ${session.fleetId}` : "No active operator session"}>
            <form className="form" onSubmit={handleLoginSubmit}>
              <label>
                Fleet
                <input value={formState.fleet_name} onChange={(event) => setFormState((value) => ({ ...value, fleet_name: event.target.value }))} />
              </label>
              <label>
                Email
                <input type="email" value={formState.email} onChange={(event) => setFormState((value) => ({ ...value, email: event.target.value }))} />
              </label>
              <label>
                Password
                <input type="password" value={formState.password} onChange={(event) => setFormState((value) => ({ ...value, password: event.target.value }))} />
              </label>
              <button className="button" type="submit">Open Console</button>
            </form>
            <StatusMessage tone={loginTone}>{loginStatus}</StatusMessage>
          </Panel>

          <Panel title="Fleet Tools" meta={lastUpdated}>
            <div className="button-row">
              <button className="button button--ghost" onClick={handleIssueToken}>Mint Enrollment Token</button>
            </div>
            <StatusMessage tone={tokenTone}>{tokenStatus}</StatusMessage>
            <div className="inline-note">
              Use the minted token with <code>POST /v1/enroll</code> or the reference adapter to join another agent to the fleet.
            </div>
          </Panel>

          <Panel title="Selected Agent">
            {!agentDetail ? (
              <EmptyState>Select an agent to inspect controls, message activity, and recent events.</EmptyState>
            ) : (
              <div className="stack">
                <div className="detail-grid">
                  <section className="card">
                    <div className="card__title">{agentDetail.agent.display_name}</div>
                    <div className="meta-text code">{agentDetail.agent.id}</div>
                    <div style={{ marginTop: 10 }}><Badge>{agentDetail.agent.status}</Badge></div>
                  </section>
                  <section className="card">
                    <div className="meta-text">Runtime</div>
                    <div>{agentDetail.agent.runtime}</div>
                    <div className="meta-text" style={{ marginTop: 10 }}>Last seen</div>
                    <div>{agentDetail.agent.last_seen_at || "never"}</div>
                  </section>
                </div>

                <section className="card">
                  <div className="card__title">Recent Controls</div>
                  {agentDetail.controls.length ? agentDetail.controls.map((control) => {
                    const payload = JSON.parse(control.payload_json || "{}");
                    return (
                      <div className="event-feed__row" key={control.id}>
                        <div className="card__head">
                          <div><Badge>{control.action}</Badge></div>
                          <div className="meta-text">{control.created_at}</div>
                        </div>
                        <div className="meta-text">{payload.reason || "no reason"}</div>
                      </div>
                    );
                  }) : <div className="meta-text" style={{ marginTop: 10 }}>No control actions yet.</div>}
                </section>

                <section className="card">
                  <div className="card__title">Recent Messages</div>
                  {agentDetail.recentMessages.length ? agentDetail.recentMessages.map((message) => (
                    <div className="event-feed__row" key={message.id}>
                      <div className="card__head">
                        <div>{message.message_type} <Badge>{message.status}</Badge></div>
                        <div className="meta-text">{message.created_at}</div>
                      </div>
                      <div className="meta-text code">{message.conversation_id}</div>
                      <div className="agent-actions">
                        <button className="button button--ghost" onClick={() => selectConversation(message.conversation_id)}>Trace</button>
                      </div>
                    </div>
                  )) : <div className="meta-text" style={{ marginTop: 10 }}>No message history yet.</div>}
                </section>
              </div>
            )}
          </Panel>
        </aside>

        <main className="main-content stack">
          <Panel title="Fleet Overview" meta={session.token ? `Fleet ${session.fleetId}` : "No session"}>
            <div className="kpi-grid">
              <KpiCard label="Agents" value={overview.agents.length} />
              <KpiCard label="Healthy" value={healthyCount} />
              <KpiCard label="Queued" value={overview.queuedMessages || 0} />
              <KpiCard label="Pending Approvals" value={overview.pendingApprovals || 0} />
            </div>
          </Panel>

          <section className="split-panel">
            <Panel title="Agents">
              <FilterBar>
                <FilterInput
                  label="Search"
                  value={agentsQuery.text}
                  onChange={(text) => updateAgentsQuery({ text, page: 1 })}
                  placeholder="name, id, runtime"
                />
                <FilterSelect
                  label="Status"
                  value={agentsQuery.status}
                  onChange={(status) => updateAgentsQuery({ status, page: 1 })}
                  options={[
                    { value: "all", label: "All statuses" },
                    { value: "healthy", label: "Healthy" },
                    { value: "paused", label: "Paused" },
                    { value: "quarantined", label: "Quarantined" },
                    { value: "degraded", label: "Degraded" },
                  ]}
                />
                <FilterSelect
                  label="Sort By"
                  value={agentsQuery.sortBy}
                  onChange={(sortBy) => updateAgentsQuery({ sortBy, page: 1 })}
                  options={[
                    { value: "last_seen_at", label: "Last Seen" },
                    { value: "display_name", label: "Display Name" },
                    { value: "status", label: "Status" },
                    { value: "created_at", label: "Created" },
                  ]}
                />
                <FilterSelect
                  label="Order"
                  value={agentsQuery.sortOrder}
                  onChange={(sortOrder) => updateAgentsQuery({ sortOrder, page: 1 })}
                  options={[
                    { value: "desc", label: "Descending" },
                    { value: "asc", label: "Ascending" },
                  ]}
                />
              </FilterBar>
              {agents.length ? (
                <div className="list">
                  {agents.map((agent) => (
                    <article className="card" key={agent.id}>
                      <div className="card__head">
                        <div>
                          <div className="card__title">{agent.display_name || agent.id}</div>
                          <div className="meta-text code">{agent.id}</div>
                        </div>
                        <Badge>{agent.status}</Badge>
                      </div>
                      <div className="meta-text">{agent.runtime || "custom"} · last seen {agent.last_seen_at || "never"}</div>
                      <div className="agent-actions" style={{ marginTop: 12 }}>
                        <button className="button button--ghost" onClick={() => selectAgent(agent.id)}>Inspect</button>
                        <button className="button button--warn" onClick={() => handleControl(agent.id, "pause")}>Pause</button>
                        <button className="button button--ghost" onClick={() => handleControl(agent.id, "resume")}>Resume</button>
                        <button className="button button--danger" onClick={() => handleControl(agent.id, "quarantine")}>Quarantine</button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <EmptyState>{session.token ? "No agents match the current filters." : "Log in to load fleet agents."}</EmptyState>
              )}
              <Pagination
                page={agentsQuery.page}
                total={agentsTotal}
                limit={agentsQuery.limit}
                onPageChange={(page) => updateAgentsQuery({ page })}
              />
            </Panel>

            <Panel title="Approvals Queue">
              <FilterBar>
                <FilterInput
                  label="Search"
                  value={approvalsQuery.text}
                  onChange={(text) => updateApprovalsQuery({ text, page: 1 })}
                  placeholder="summary, agent, action"
                />
                <FilterSelect
                  label="Risk"
                  value={approvalsQuery.risk}
                  onChange={(risk) => updateApprovalsQuery({ risk, page: 1 })}
                  options={[
                    { value: "all", label: "All risk levels" },
                    { value: "low", label: "Low" },
                    { value: "medium", label: "Medium" },
                    { value: "high", label: "High" },
                    { value: "critical", label: "Critical" },
                  ]}
                />
                <FilterInput
                  label="From"
                  type="date"
                  value={approvalsQuery.dateFrom}
                  onChange={(dateFrom) => updateApprovalsQuery({ dateFrom, page: 1 })}
                />
                <FilterInput
                  label="To"
                  type="date"
                  value={approvalsQuery.dateTo}
                  onChange={(dateTo) => updateApprovalsQuery({ dateTo, page: 1 })}
                />
                <FilterSelect
                  label="Sort By"
                  value={approvalsQuery.sortBy}
                  onChange={(sortBy) => updateApprovalsQuery({ sortBy, page: 1 })}
                  options={[
                    { value: "requested_at", label: "Requested" },
                    { value: "risk_level", label: "Risk" },
                    { value: "summary", label: "Summary" },
                  ]}
                />
                <FilterSelect
                  label="Order"
                  value={approvalsQuery.sortOrder}
                  onChange={(sortOrder) => updateApprovalsQuery({ sortOrder, page: 1 })}
                  options={[
                    { value: "desc", label: "Descending" },
                    { value: "asc", label: "Ascending" },
                  ]}
                />
              </FilterBar>
              {approvals.length ? (
                <div className="list">
                  {approvals.map((approval) => (
                    <article className="card" key={approval.id}>
                      <div className="card__head">
                        <div>
                          <div className="card__title">{approval.summary}</div>
                          <div className="meta-text">{approval.display_name || approval.agent_id} · {approval.action_type}</div>
                        </div>
                        <Badge>{approval.risk_level}</Badge>
                      </div>
                      <div className="meta-text">Requested {approval.requested_at}</div>
                      <div className="approval-actions" style={{ marginTop: 12 }}>
                        <button className="button" onClick={() => handleApproval(approval.id, "approve")}>Approve</button>
                        <button className="button button--danger" onClick={() => handleApproval(approval.id, "reject")}>Reject</button>
                        <button className="button button--ghost" onClick={() => selectConversation(approval.conversation_id)}>Trace</button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <EmptyState>{approvals.length ? "No approvals match the current filters." : "No pending approvals."}</EmptyState>
              )}
              <Pagination
                page={approvalsQuery.page}
                total={approvalsTotal}
                limit={approvalsQuery.limit}
                onPageChange={(page) => updateApprovalsQuery({ page })}
              />
            </Panel>
          </section>

          <Panel title="Recent Events" meta="Latest fleet activity">
            <FilterBar>
              <FilterInput
                label="Search"
                value={eventsQuery.text}
                onChange={(text) => updateEventsQuery({ text, page: 1 })}
                placeholder="event, actor, resource, conversation"
              />
              <FilterSelect
                label="Type"
                value={eventsQuery.type}
                onChange={(type) => updateEventsQuery({ type, page: 1 })}
                options={eventTypeOptions}
              />
              <FilterInput
                label="From"
                type="date"
                value={eventsQuery.dateFrom}
                onChange={(dateFrom) => updateEventsQuery({ dateFrom, page: 1 })}
              />
              <FilterInput
                label="To"
                type="date"
                value={eventsQuery.dateTo}
                onChange={(dateTo) => updateEventsQuery({ dateTo, page: 1 })}
              />
              <FilterSelect
                label="Sort By"
                value={eventsQuery.sortBy}
                onChange={(sortBy) => updateEventsQuery({ sortBy, page: 1 })}
                options={[
                  { value: "created_at", label: "Created" },
                  { value: "event_type", label: "Event Type" },
                  { value: "actor_id", label: "Actor" },
                  { value: "resource_kind", label: "Resource" },
                ]}
              />
              <FilterSelect
                label="Order"
                value={eventsQuery.sortOrder}
                onChange={(sortOrder) => updateEventsQuery({ sortOrder, page: 1 })}
                options={[
                  { value: "desc", label: "Descending" },
                  { value: "asc", label: "Ascending" },
                ]}
              />
            </FilterBar>
            <EventFeed events={events} onConversationSelect={selectConversation} />
            <Pagination
              page={eventsQuery.page}
              total={eventsTotal}
              limit={eventsQuery.limit}
              onPageChange={(page) => updateEventsQuery({ page })}
            />
          </Panel>

          <Panel title="Conversation Timeline" meta={selectedConversationId ? `Tracing ${selectedConversationId}` : "Select a conversation from an approval, agent card, or event row."}>
            <FilterBar>
              <FilterInput
                label="Search"
                value={timelineQuery.text}
                onChange={(text) => updateTimelineQuery({ text, page: 1 })}
                placeholder="event, actor, payload"
              />
              <FilterSelect
                label="Type"
                value={timelineQuery.type}
                onChange={(type) => updateTimelineQuery({ type, page: 1 })}
                options={timelineTypeOptions}
              />
              <FilterInput
                label="From"
                type="date"
                value={timelineQuery.dateFrom}
                onChange={(dateFrom) => updateTimelineQuery({ dateFrom, page: 1 })}
              />
              <FilterInput
                label="To"
                type="date"
                value={timelineQuery.dateTo}
                onChange={(dateTo) => updateTimelineQuery({ dateTo, page: 1 })}
              />
              <FilterSelect
                label="Sort By"
                value={timelineQuery.sortBy}
                onChange={(sortBy) => updateTimelineQuery({ sortBy, page: 1 })}
                options={[
                  { value: "created_at", label: "Created" },
                  { value: "event_type", label: "Event Type" },
                  { value: "actor_id", label: "Actor" },
                  { value: "resource_kind", label: "Resource" },
                ]}
              />
              <FilterSelect
                label="Order"
                value={timelineQuery.sortOrder}
                onChange={(sortOrder) => updateTimelineQuery({ sortOrder, page: 1 })}
                options={[
                  { value: "asc", label: "Ascending" },
                  { value: "desc", label: "Descending" },
                ]}
              />
            </FilterBar>
            <Timeline
              conversationId={selectedConversationId}
              events={timelineEvents}
              onRefresh={() => {
                if (selectedConversationId) {
                  refreshTimeline(selectedConversationId).catch((error) => handleApiError(error, { allowSessionReset: true }));
                }
              }}
            />
            <Pagination
              page={timelineQuery.page}
              total={timelineTotal}
              limit={timelineQuery.limit}
              onPageChange={(page) => updateTimelineQuery({ page })}
            />
          </Panel>
        </main>
      </div>
    </div>
  );
}
