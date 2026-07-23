import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { CommandRecord } from "../../../packages/contracts/src/index";
import {
  bootstrapAuth,
  cancelCommand,
  createCommand,
  enableTotp,
  getAudit,
  getCommandEvents,
  getCommands,
  getDashboard,
  login,
  logout,
  createTemporaryVideoUpload,
  finalizeTemporaryVideoUpload,
  putTemporaryVideo,
  retryCommand,
  setupTotp,
} from "./api";
import { ManualNews, News, Scrapers, WhatsAppSelector, normalizeGroups } from "./content";
import {
  Badge,
  Card,
  Empty,
  Field,
  PlatformChooser,
  Progress,
  ReadableData,
  ResultSummary,
  Stat,
  StatusDot,
  TechnicalDetails,
  commandLabel,
  shortDate,
  statusLabel,
  type ContentItem,
  type RunCommand,
} from "./ui";

type Tab = "dashboard" | "manual-news" | "news" | "scrapers" | "videos" | "automation" | "commands" | "audit" | "settings";
type IconName = "home" | "manual-news" | "news" | "scraper" | "video" | "automation" | "queue" | "audit" | "security";
type NavItem = { id: Tab; label: string; description: string; icon: IconName };

const navGroups: Array<{ title: string; items: NavItem[] }> = [
  { title: "Inicio", items: [{ id: "dashboard", label: "Resumen", description: "Estado general y acciones rápidas", icon: "home" }] },
  { title: "Contenido", items: [
    { id: "scrapers", label: "Scrapers", description: "Buscar, preparar y publicar", icon: "scraper" },
    { id: "manual-news", label: "Publicación manual", description: "Crear una noticia y publicarla en uno o más destinos", icon: "manual-news" },
    { id: "news", label: "Noticias", description: "Redacción, WordPress y redes", icon: "news" },
    { id: "videos", label: "Videos", description: "Procesamiento, publicación y R2", icon: "video" },
  ] },
  { title: "Operación", items: [
    { id: "automation", label: "Automatización", description: "Runtime, sesiones y trabajos locales", icon: "automation" },
    { id: "commands", label: "Cola de trabajos", description: "Seguimiento, reintentos y detalle", icon: "queue" },
    { id: "audit", label: "Auditoría", description: "Registro de accesos y acciones", icon: "audit" },
  ] },
  { title: "Cuenta", items: [{ id: "settings", label: "Seguridad", description: "Cuenta y segundo factor", icon: "security" }] },
];
const nav = navGroups.flatMap((group) => group.items);

export function App() {
  const [user, setUser] = useState<any>(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [dashboard, setDashboard] = useState<any>(null);
  const [commands, setCommands] = useState<CommandRecord[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const [nextDashboard, nextHistory] = await Promise.all([
        getDashboard(),
        tab === "commands" ? getCommands() : Promise.resolve(null),
      ]);
      setDashboard(nextDashboard);
      setCommands(nextHistory?.items ?? nextDashboard.commands ?? []);
      setError("");
    } catch (cause) {
      setError(message(cause));
    }
  }, [tab, user]);

  useEffect(() => {
    bootstrapAuth().then(setUser).catch(() => undefined).finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    void refresh();
    const pollMs = (dashboard?.counts?.active ?? 0) > 0 ? 2000 : 10000;
    const timer = window.setInterval(refresh, pollMs);
    return () => window.clearInterval(timer);
  }, [dashboard?.counts?.active, user, refresh]);

  const run: RunCommand = async (type, payload, success = "Comando encolado") => {
    try {
      const result = await createCommand(type, payload);
      setNotice(success);
      setError("");
      const command = result.command as CommandRecord;
      setCommands((current) => [command, ...current.filter((item) => item.id !== command.id)]);
      void refresh();
      return command;
    } catch (cause) {
      setError(message(cause));
      return null;
    }
  };

  if (checking) return <div className="center"><div className="loader" /></div>;
  if (!user) return <Login onLogin={setUser} />;

  const snapshots = Object.fromEntries((dashboard?.snapshots ?? []).map((snapshot: any) => [snapshot.key, snapshot]));
  const currentPage = nav.find((item) => item.id === tab) ?? nav[0]!;
  const navigate = (next: Tab) => {
    setTab(next);
    setMobileNavOpen(false);
  };

  return (
    <div className={`shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className={mobileNavOpen ? "mobile-open" : ""}>
        <div className="brand-panel">
          <div className="brand"><div className="brand-mark">HS</div><div className="brand-copy"><strong>HolaSalta</strong><span>Operations</span></div></div>
          <button className="mobile-close" onClick={() => setMobileNavOpen(false)} aria-label="Cerrar navegación">×</button>
        </div>
        <nav aria-label="Navegación principal">
          {navGroups.map((group) => (
            <div className="nav-group" key={group.title}>
              <p>{group.title}</p>
              {group.items.map((item) => (
                <button key={item.id} title={item.label} className={tab === item.id ? "active" : ""} onClick={() => navigate(item.id)}>
                  <NavIcon name={item.icon} /><span>{item.label}</span>
                  {item.id === "commands" && (dashboard?.counts?.active ?? 0) > 0 && <b>{dashboard.counts.active}</b>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div><StatusDot online={dashboard?.agent?.online} /><span>{dashboard?.agent?.online ? "PC operativa conectada" : "PC operativa sin conexión"}</span></div>
          <small>Las tareas pesadas se ejecutan localmente.</small>
        </div>
      </aside>
      {mobileNavOpen && <button className="nav-backdrop" aria-label="Cerrar navegación" onClick={() => setMobileNavOpen(false)} />}

      <div className="content-shell">
        <header className="topbar">
          <div className="topbar-start">
            <button className="icon-button mobile-menu" onClick={() => setMobileNavOpen(true)} aria-label="Abrir navegación">☰</button>
            <button className="icon-button collapse-button" onClick={() => setSidebarCollapsed((value) => !value)} aria-label="Contraer navegación">{sidebarCollapsed ? "›" : "‹"}</button>
            <div><strong>{currentPage.label}</strong><span>HolaSalta Ops</span></div>
          </div>
          <div className="topbar-end">
            <button className={`agent-pill ${dashboard?.agent?.online ? "online" : "offline"}`} onClick={() => navigate("dashboard")}><StatusDot online={dashboard?.agent?.online} />{dashboard?.agent?.online ? "Agente conectado" : "Agente desconectado"}</button>
            <button className="jobs-pill" onClick={() => navigate("commands")}>Activos <b>{dashboard?.counts?.active ?? 0}</b></button>
            <div className="user"><span>{user.email}</span><button className="ghost" onClick={() => logout().then(() => setUser(null))}>Salir</button></div>
          </div>
        </header>

        <main className="workspace">
          <div className="page-heading"><div><p className="eyebrow">HolaSalta Operations</p><h1>{currentPage.label}</h1><p>{currentPage.description}</p></div><button className="refresh-button" onClick={() => void refresh()}>Actualizar vista</button></div>
          {error && <div className="alert error">{error}<button onClick={() => setError("")}>×</button></div>}
          {notice && <div className="alert success">{notice}<button onClick={() => setNotice("")}>×</button></div>}
          {tab === "dashboard" && <Dashboard data={dashboard} commands={commands} snapshots={snapshots} run={run} navigate={navigate} />}
          {tab === "scrapers" && <Scrapers commands={commands} snapshots={snapshots} run={run} />}
          {tab === "manual-news" && <ManualNews commands={commands} snapshots={snapshots} run={run} />}
          {tab === "news" && <News commands={commands} snapshots={snapshots} run={run} />}
          {tab === "automation" && <Automation snapshots={snapshots} run={run} />}
          {tab === "videos" && <Videos snapshots={snapshots} commands={commands} run={run} />}
          {tab === "commands" && <Commands items={commands} refresh={refresh} />}
          {tab === "audit" && <Audit />}
          {tab === "settings" && <Settings user={user} setUser={setUser} />}
        </main>
      </div>
    </div>
  );
}

function Login({ onLogin }: { onLogin(user: any): void }) {
  const [email, setEmail] = useState("holasalta@acceso.com");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      onLogin(await login(email, password, totp));
    } catch (cause: any) {
      setError(cause.code === "TOTP_REQUIRED" ? "La cuenta requiere el código de autenticación." : message(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="brand login-brand"><div className="brand-mark">HS</div><div><strong>HolaSalta Ops</strong><span>Acceso autorizado</span></div></div>
        <form onSubmit={submit}>
          <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" /></label>
          <label>Contraseña<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" autoFocus /></label>
          <label>Código 2FA <small>(si está activado)</small><input inputMode="numeric" maxLength={6} value={totp} onChange={(event) => setTotp(event.target.value.replace(/\D/g, ""))} /></label>
          {error && <div className="inline-error">{error}</div>}
          <button className="primary wide" disabled={busy}>{busy ? "Ingresando…" : "Ingresar"}</button>
        </form>
      </div>
    </div>
  );
}

function Dashboard({ data, commands, snapshots, run, navigate }: any) {
  const status = snapshots["automation.status"]?.payload;
  const snapshotList = Object.values(snapshots) as any[];
  const available = snapshotList.filter((item) => !item?.payload?.unavailable).length;
  const successful = commands.filter((command: CommandRecord) => command.status === "completed").length;
  return (
    <>
      <section className="stats">
        <Stat label="Agente local" value={data?.agent?.online ? "Conectado" : "Desconectado"} tone={data?.agent?.online ? "good" : "bad"} />
        <Stat label="Trabajos activos" value={data?.counts?.active ?? 0} />
        <Stat label="Completados" value={successful} tone="good" />
        <Stat label="Requieren atención" value={data?.counts?.attention ?? 0} tone={data?.counts?.attention ? "warn" : "good"} />
      </section>
      <section className="dashboard-grid">
        <Card title="Acciones rápidas" eyebrow="Operación diaria">
          <div className="quick-actions">
            <button onClick={() => navigate("scrapers")}><NavIcon name="scraper" /><span><strong>Buscar noticias</strong><small>Abrir flujo editorial</small></span></button>
            <button onClick={() => navigate("manual-news")}><NavIcon name="manual-news" /><span><strong>Crear noticia manual</strong><small>Redactar y publicar en múltiples destinos</small></span></button>
            <button onClick={() => void run("snapshot.refresh", {})}><NavIcon name="queue" /><span><strong>Sincronizar estado</strong><small>Actualizar datos locales</small></span></button>
            <button onClick={() => void run("automation.restart", {})}><NavIcon name="automation" /><span><strong>Reiniciar runtime</strong><small>Restablecer workers</small></span></button>
          </div>
        </Card>
        <Card title="Salud operativa" eyebrow="PC local">
          <div className="health-list">
            <HealthRow label="Backend local" value={data?.agent?.status ?? "offline"} good={data?.agent?.online} />
            <HealthRow label="Automatización" value={String(status?.status ?? "Sin datos")} good={status?.status === "running" || status?.status === "healthy"} />
            <HealthRow label="Último contacto" value={shortDate(data?.agent?.lastSeenAt)} good={data?.agent?.online} />
            <HealthRow label="Datos sincronizados" value={`${available}/${snapshotList.length}`} good={available > 0} />
          </div>
        </Card>
      </section>
      <Card title="Actividad reciente" eyebrow="Últimos comandos" actions={<button onClick={() => navigate("commands")}>Ver toda la cola</button>}>
        <CommandTable items={commands.slice(0, 10)} />
      </Card>
    </>
  );
}

function Automation({ snapshots, run }: { snapshots: Record<string, any>; run: RunCommand }) {
  const status = snapshots["automation.status"]?.payload ?? {};
  const jobs = normalizeItems(snapshots["automation.jobs"]?.payload);
  const pendingPayload = snapshots["instagram.pending"]?.payload;
  const pending = normalizeItems(pendingPayload?.pending ?? pendingPayload);
  const platforms = status?.platforms ?? {};
  const queues = { whatsapp: status?.wpp_queues ?? {}, x: status?.x_queues ?? {} };
  const runtimeStatus = String(status?.status ?? "unknown");
  const runtimeRunning = ["running", "healthy"].includes(runtimeStatus);

  return (
    <div className="flow-page">
      <section className="grid two">
        <Card
          title="Runtime local"
          eyebrow="Control"
          actions={
            <>
              <button onClick={() => void run("automation.start", {})}>Iniciar</button>
              <button onClick={() => void run("automation.restart", {})}>Reiniciar</button>
              <button className="danger-ghost" onClick={() => confirmed("¿Detener la automatización local?") && void run("automation.stop", {})}>Detener</button>
            </>
          }
        >
          <div className={`runtime-callout ${runtimeRunning ? "good" : "warn"}`}>
            <strong>{runtimeRunning ? "Automatización en ejecución" : "Automatización detenida"}</strong>
            <span>{runtimeRunning ? "Los workers locales están disponibles para WhatsApp y X." : "El agente sigue conectado, pero los workers de navegador no están iniciados. Use Iniciar para habilitar WhatsApp y X."}</span>
          </div>
          <div className="data-grid runtime-grid">
            <div className="data-row"><span>Estado</span><strong>{runtimeRunning ? "En ejecución" : runtimeStatus === "stopped" ? "Detenido" : statusLabel(runtimeStatus)}</strong></div>
            <div className="data-row"><span>Modo</span><strong>{status?.mode === "local" ? "En esta PC" : String(status?.mode ?? "—")}</strong></div>
            <div className="data-row"><span>Runtime iniciado</span><strong>{status?.runtime_started ? "Sí" : "No"}</strong></div>
            <div className="data-row"><span>Última señal</span><strong>{shortDate(status?.runtime_heartbeat)}</strong></div>
            <div className="data-row"><span>Estado actualizado</span><strong>{shortDate(status?.updated_at)}</strong></div>
            <div className="data-row"><span>Eventos recientes</span><strong>{Array.isArray(status?.recent_events) ? status.recent_events.length : 0}</strong></div>
          </div>
          <TechnicalDetails value={status} label="Ver diagnóstico técnico del runtime" />
        </Card>
        <Card title="Sesiones y colas" eyebrow="Plataformas">
          <h3 className="subheading">Sesiones</h3>
          <ReadableData value={platforms} empty="Sin sesiones informadas." />
          <h3 className="subheading">Colas</h3>
          <ReadableData value={queues} empty="Sin métricas de colas." />
          <TechnicalDetails value={{ platforms, queues }} />
        </Card>
      </section>

      <Card
        title="Trabajos locales"
        eyebrow="Automatización"
        actions={<button className="danger-ghost" onClick={() => confirmed("¿Limpiar los trabajos locales finalizados?") && void run("automation.jobs.clear", {})}>Limpiar finalizados</button>}
      >
        <div className="table-wrap">
          <table>
            <thead><tr><th>Trabajo</th><th>Estado</th><th>Etapa</th><th>Progreso</th><th>Actualizado</th><th /></tr></thead>
            <tbody>
              {jobs.map((job) => {
                const id = String(job.job_id ?? job.id ?? "");
                const active = ["queued", "claimed", "running", "processing"].includes(String(job.status));
                return (
                  <tr key={id}>
                    <td><strong>{String(job.title ?? job.type ?? "Trabajo local")}</strong><small className="command-code">{id.slice(0, 12)}</small></td>
                    <td><Badge status={String(job.status ?? "unknown")} /></td>
                    <td>{String(job.current_stage ?? "—")}</td>
                    <td>{Number(job.progress_percent ?? 0)}%</td>
                    <td>{shortDate(job.updated_at)}</td>
                    <td>{active && <button onClick={() => confirmed("¿Cancelar este trabajo local?") && void run("automation.job.cancel", { jobId: id })}>Cancelar</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!jobs.length && <Empty text="No hay trabajos locales sincronizados" />}
      </Card>

      <Card title="Pendientes de Instagram" eyebrow="Intervención">
        <div className="attention-list">
          {pending.map((item, index) => {
            const id = String(item.id ?? item.pending_id ?? index);
            return (
              <article key={id}>
                <div><strong>{String(item.reason ?? item.title ?? "Publicación pendiente")}</strong><span>{String(item.last_error ?? item.error ?? "Requiere revisión")}</span><small>{shortDate(item.updated_at ?? item.created_at)}</small></div>
                <div className="actions"><button onClick={() => void run("instagram.pending.retry", { pendingId: id })}>Reintentar</button><button className="danger-ghost" onClick={() => confirmed("¿Eliminar este pendiente?") && void run("instagram.pending.delete", { pendingId: id })}>Eliminar</button></div>
              </article>
            );
          })}
          {!pending.length && <Empty text="No hay pendientes de Instagram" />}
        </div>
      </Card>
    </div>
  );
}

function Videos({ snapshots, commands, run }: { snapshots: Record<string, any>; commands: CommandRecord[]; run: RunCommand }) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [quality, setQuality] = useState("normal");
  const [textMode, setTextMode] = useState("auto");
  const [localFile, setLocalFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadState, setUploadState] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [batch, setBatch] = useState("");
  const [batchAction, setBatchAction] = useState("process");
  const [platforms, setPlatforms] = useState<string[]>(["facebook", "instagram", "x"]);
  const [selectedJobs, setSelectedJobs] = useState<string[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [selectedGroupSet, setSelectedGroupSet] = useState<ContentItem | null>(null);
  const jobs = normalizeItems(snapshots["xvideo.jobs"]?.payload);
  const groups = normalizeGroups(snapshots["whatsapp.groups"]?.payload);
  const selectedGroups = selectedGroupSet ? normalizeGroups(selectedGroupSet) : groups.filter((group) => selectedGroupIds.includes(String(group.id)));
  const exports = commands.filter((command) => command.type === "xvideo.export_r2" && command.status === "completed" && command.result);

  async function createSingle() {
    if (!url.trim()) return;
    const command = await run("xvideo.create_url", { sourceUrl: url.trim(), title, caption, quality, textMode }, "Procesamiento de video encolado");
    if (command) {
      setUrl("");
      setTitle("");
      setCaption("");
    }
  }

  async function createFromFile() {
    if (!localFile) return;
    setUploadError("");
    setUploadProgress(0);
    try {
      if (localFile.size <= 0 || localFile.size > 250 * 1024 * 1024) throw new Error("El video debe pesar entre 1 byte y 250 MB.");
      const contentType = videoMime(localFile);
      if (!contentType) throw new Error("Usá un archivo MP4, MOV, M4V o WebM válido.");
      setUploadState("Creando carga segura");
      const ticket = await createTemporaryVideoUpload({
        fileName: localFile.name,
        contentType,
        sizeBytes: localFile.size,
        title,
        caption,
        quality: quality as "borrador" | "rapido" | "normal",
        textMode: textMode as "auto" | "manual" | "disabled",
      });
      setUploadState("Subiendo directamente a R2");
      await putTemporaryVideo(ticket, localFile, setUploadProgress);
      setUploadProgress(100);
      setUploadState("Validando y encolando");
      await finalizeTemporaryVideoUpload(ticket.uploadId);
      setUploadState("Carga encolada para procesamiento");
      setLocalFile(null);
      setTitle("");
      setCaption("");
    } catch (error) {
      setUploadState("");
      setUploadError(error instanceof Error ? error.message : "No se pudo cargar el video.");
    }
  }

  async function createBatch() {
    const sourceUrls = uniqueLines(batch);
    if (!sourceUrls.length) return;
    await run("xvideo.batch.create", {
      sourceUrls,
      quality,
      textMode,
      action: batchAction,
      platforms: batchAction === "publish" ? platforms : [],
      whatsappGroups: batchAction === "publish" ? selectedGroups : [],
      whatsappGroupSet: batchAction === "publish" ? selectedGroupSet : null,
    }, "Lote de videos encolado");
  }

  return (
    <div className="flow-page">
      <section className="grid two">
        <Card title="Nuevo video" eyebrow="X, YouTube, R2 o archivo local">
          <Field label="URL de origen"><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" /></Field>
          <div className="source-divider"><span>o cargá desde este dispositivo</span></div>
          <Field label="Archivo MP4, MOV, M4V o WebM (máx. 250 MB)">
            <input
              type="file"
              accept=".mp4,.mov,.m4v,.webm,video/mp4,video/quicktime,video/x-m4v,video/webm"
              onChange={(event) => setLocalFile(event.target.files?.[0] ?? null)}
            />
          </Field>
          <div className="grid two form-grid">
            <Field label="Calidad">
              <select value={quality} onChange={(event) => setQuality(event.target.value)}><option value="borrador">Borrador</option><option value="rapido">Rápido</option><option value="normal">Normal</option></select>
            </Field>
            <Field label="Texto">
              <select value={textMode} onChange={(event) => setTextMode(event.target.value)}><option value="auto">Automático</option><option value="manual">Manual</option><option value="disabled">Sin texto</option></select>
            </Field>
          </div>
          <Field label="Título"><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={180} /></Field>
          <Field label="Caption"><textarea rows={5} value={caption} onChange={(event) => setCaption(event.target.value)} maxLength={2200} /></Field>
          <div className="grid two form-grid">
            <button className="primary wide" disabled={!url.trim() || Boolean(localFile)} onClick={() => void createSingle()}>Procesar URL</button>
            <button className="primary wide" disabled={!localFile || Boolean(url.trim()) || Boolean(uploadState && uploadProgress < 100)} onClick={() => void createFromFile()}>Cargar archivo</button>
          </div>
          {uploadState && (
            <div className="upload-progress" role="status">
              <span>{uploadState}</span>
              <progress max={100} value={uploadProgress} />
            </div>
          )}
          {uploadError && <div className="inline-error">{uploadError}</div>}
        </Card>

        <Card title="Lote desde URLs" eyebrow="Hasta 100 videos">
          <Field label="Una URL por línea"><textarea rows={10} value={batch} onChange={(event) => setBatch(event.target.value)} placeholder="https://…&#10;https://…" /></Field>
          <Field label="Acción al terminar">
            <select value={batchAction} onChange={(event) => setBatchAction(event.target.value)}>
              <option value="process">Solo procesar</option>
              <option value="download">Preparar descarga</option>
              <option value="publish">Procesar y publicar</option>
            </select>
          </Field>
          <button className="primary wide" disabled={!uniqueLines(batch).length || (batchAction === "publish" && !platforms.length)} onClick={() => void createBatch()}>Crear lote</button>
        </Card>
      </section>

      <Card title="Destinos de video" eyebrow="Publicación">
        <PlatformChooser selected={platforms} allowed={["facebook", "instagram", "x", "whatsapp"]} onChange={setPlatforms} />
        {platforms.includes("whatsapp") && (
          <WhatsAppSelector snapshots={snapshots} selectedIds={selectedGroupIds} selectedSet={selectedGroupSet} onSelectedIds={setSelectedGroupIds} onSelectedSet={setSelectedGroupSet} run={run} />
        )}
      </Card>

      <Card
        title="Videos locales"
        eyebrow="Producción"
        actions={
          <>
            <button disabled={!selectedJobs.length || !platforms.length || (platforms.includes("whatsapp") && !selectedGroups.length)} onClick={() => void run("xvideo.batch.publish", { jobIds: selectedJobs, platforms, whatsappGroups: selectedGroups, whatsappGroupSet: selectedGroupSet }, "Publicación del lote encolada")}>Publicar seleccionados ({selectedJobs.length})</button>
            <button onClick={() => void run("xvideo.clear_cache", {})}>Limpiar caché</button>
            <button className="danger-ghost" onClick={() => confirmed("¿Limpiar los trabajos de video finalizados?") && void run("xvideo.clear_jobs", {})}>Limpiar trabajos</button>
          </>
        }
      >
        <div className="video-grid">
          {jobs.map((job, index) => {
            const id = String(job.job_id ?? job.id ?? index);
            return (
              <VideoJobCard
                key={id}
                job={job}
                selected={selectedJobs.includes(id)}
                onSelected={() => setSelectedJobs((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])}
                platforms={platforms}
                groups={selectedGroups}
                groupSet={selectedGroupSet}
                run={run}
              />
            );
          })}
          {!jobs.length && <Empty text="No hay videos sincronizados" detail="Procesá una URL o un lote para comenzar." />}
        </div>
      </Card>

      {exports.length > 0 && (
        <Card title="Descargas desde R2" eyebrow="holasaltamedia.cc">
          <div className="download-list">
            {exports.map((command) => {
              const result = command.result as any;
              return <div key={command.id}><span><strong>{String(result?.jobId ?? command.localJobId ?? "Video")}</strong><small>{shortDate(command.updatedAt)}</small></span>{result?.downloadUrl && <a className="button" href={String(result.downloadUrl)} target="_blank" rel="noreferrer">Descargar</a>}</div>;
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

function VideoJobCard({ job, selected, onSelected, platforms, groups, groupSet, run }: { job: ContentItem; selected: boolean; onSelected(): void; platforms: string[]; groups: ContentItem[]; groupSet: ContentItem | null; run: RunCommand }) {
  const id = String(job.job_id ?? job.id ?? "");
  const [title, setTitle] = useState(String(job.title ?? ""));
  const [caption, setCaption] = useState(String(job.caption ?? ""));
  const ready = String(job.status) === "ready";
  const canPublish = ready && platforms.length > 0 && (!platforms.includes("whatsapp") || groups.length > 0);
  return (
    <article className={`video-card ${selected ? "selected" : ""}`}>
      <button className="article-select" onClick={onSelected}><span>{selected ? "✓" : ""}</span></button>
      <div className="video-card-head"><Badge status={String(job.status ?? "unknown")} /><small>{shortDate(job.updated_at ?? job.created_at)}</small></div>
      {job.preview_url
        && job.preview_upload_status === "ready"
        && Number(job.preview_revision) === Number(job.render_revision)
        && <video className="video-preview" src={String(job.preview_url)} controls playsInline preload="metadata" />}
      {job.preview_upload_status && job.preview_upload_status !== "ready" && (
        <div className={job.preview_upload_status === "error" ? "inline-warning" : "preview-state"}>
          Preview: {statusLabel(String(job.preview_upload_status))}
          {job.preview_error ? ` · ${String(job.preview_error)}` : ""}
        </div>
      )}
      <Field label="Título"><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={180} /></Field>
      <Field label="Caption"><textarea rows={4} value={caption} onChange={(event) => setCaption(event.target.value)} maxLength={2200} /></Field>
      <div className="actions">
        <button onClick={() => void run("xvideo.update", { jobId: id, title, caption }, job.preview_upload_status === "error" ? "Reintento de preview encolado" : "Edición de video encolada")}>{job.preview_upload_status === "error" ? "Reintentar preview" : "Guardar texto"}</button>
        <button disabled={!ready} onClick={() => void run("xvideo.share_test", { jobId: id }, "Prueba de WhatsApp encolada")}>Grupo de prueba</button>
        <button className="primary" disabled={!canPublish} onClick={() => void run("xvideo.publish", { jobId: id, platforms, title, caption, whatsappGroups: groups, whatsappGroupSet: groupSet }, "Publicación de video encolada")}>Publicar</button>
        <button disabled={!ready} onClick={() => void run("xvideo.export_r2", { jobId: id, filename: `${id}.mp4` }, "Exportación a R2 encolada")}>Subir a R2</button>
      </div>
      {job.platform_results && <TechnicalDetails value={job.platform_results} label="Ver resultados por plataforma" />}
    </article>
  );
}

function Commands({ items, refresh }: { items: CommandRecord[]; refresh(): Promise<void> }) {
  const [selected, setSelected] = useState<CommandRecord | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [filter, setFilter] = useState("all");
  const filtered = filter === "all" ? items : items.filter((item) => item.status === filter);
  const active = items.filter((item) => ["queued", "claimed", "running"].includes(item.status)).length;
  const failed = items.filter((item) => ["failed", "requires_attention", "waiting_manual_retry"].includes(item.status)).length;

  async function open(item: CommandRecord) {
    setSelected(item);
    try {
      setEvents((await getCommandEvents(item.id)).items);
    } catch {
      setEvents([]);
    }
  }

  return (
    <>
      <section className="queue-summary">
        <Stat label="Total visible" value={items.length} />
        <Stat label="En ejecución" value={active} tone={active ? "neutral" : "good"} />
        <Stat label="Con error o atención" value={failed} tone={failed ? "bad" : "good"} />
      </section>
      <Card title="Cola e historial" eyebrow="Agente local">
        <div className="section-heading">
          <p>Las tareas pesadas se reclaman y ejecutan en la PC operativa.</p>
          <div className="queue-controls">
            <select value={filter} onChange={(event) => setFilter(event.target.value)}>
              <option value="all">Todos los estados</option>
              <option value="queued">En cola</option>
              <option value="running">Ejecutando</option>
              <option value="completed">Completados</option>
              <option value="failed">Fallidos</option>
              <option value="requires_attention">Requieren atención</option>
            </select>
            <button onClick={() => void refresh()}>Actualizar</button>
          </div>
        </div>
        {filtered.length ? <CommandTable items={filtered} onOpen={open} /> : <Empty text="No hay trabajos para este filtro" />}
      </Card>
      {selected && (
        <div className="modal-backdrop" onClick={() => setSelected(null)}>
          <section className="modal command-modal" onClick={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setSelected(null)}>×</button>
            <p className="eyebrow">Detalle del trabajo</p>
            <h2>{commandLabel(selected.type)}</h2>
            <div className="modal-meta"><Badge status={selected.status} /><span>{shortDate(selected.createdAt)}</span><code>{selected.id.slice(0, 8)}</code></div>
            <Progress command={selected} />
            {selected.errorMessage && <div className="command-error"><strong>{selected.errorCode ?? "Error de ejecución"}</strong><p>{selected.errorMessage}</p></div>}
            {selected.result ? <ResultSummary command={selected} /> : <Empty text="El trabajo todavía no produjo un resultado" />}
            {events.length > 0 && (
              <div className="event-timeline">
                <h3>Actividad</h3>
                {events.map((event, index) => <div key={String(event.id ?? index)}><span /><p><strong>{String(event.message ?? event.eventType ?? "Evento")}</strong><small>{shortDate(event.createdAt ?? event.created_at)}</small></p></div>)}
              </div>
            )}
            <TechnicalDetails value={{ command: selected, events }} />
            <div className="actions modal-actions">
              {["queued", "claimed"].includes(selected.status) && <button onClick={() => cancelCommand(selected.id).then(refresh)}>Cancelar</button>}
              {["failed", "waiting_manual_retry", "requires_attention"].includes(selected.status) && <button className="primary" onClick={() => retryCommand(selected.id).then(refresh)}>Reintentar</button>}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function Audit() {
  const [items, setItems] = useState<any[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    getAudit().then((result) => setItems(result.items)).catch((cause) => setError(message(cause)));
  }, []);
  return (
    <Card title="Auditoría administrativa" eyebrow="Trazabilidad">
      {error && <div className="inline-error">{error}</div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Fecha</th><th>Actor</th><th>Acción</th><th>Destino</th><th>Resultado</th></tr></thead>
          <tbody>
            {items.map((item) => <tr key={item.id}><td>{shortDate(item.createdAt)}</td><td>{String(item.actorType)}</td><td>{humanize(item.action)}</td><td>{humanize(item.targetType ?? "—")}</td><td><Badge status={String(item.result)} /></td></tr>)}
          </tbody>
        </table>
      </div>
      {!items.length && !error && <Empty text="No hay eventos de auditoría" />}
    </Card>
  );
}

function Settings({ user, setUser }: any) {
  const [setup, setSetup] = useState<any>(null);
  const [code, setCode] = useState("");
  return (
    <section className="grid two">
      <Card title="Autenticación de dos factores" eyebrow="Seguridad">
        <p>Estado: <strong>{user.totpEnabled ? "Activado" : "Desactivado"}</strong></p>
        {!user.totpEnabled && !setup && <button onClick={() => setupTotp().then(setSetup)}>Configurar aplicación autenticadora</button>}
        {setup && (
          <>
            <p className="card-intro">Ingresá esta clave una sola vez en tu aplicación autenticadora. No la compartas.</p>
            <code className="secret-display">{setup.secret}</code>
            <Field label="Código de 6 dígitos"><input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} maxLength={6} inputMode="numeric" /></Field>
            <button className="primary" disabled={code.length !== 6} onClick={() => enableTotp(code).then(() => setUser({ ...user, totpEnabled: true }))}>Activar 2FA</button>
          </>
        )}
      </Card>
      <Card title="Política de seguridad" eyebrow="Protecciones activas">
        <ul className="security-list">
          <li>Cookie HttpOnly y SameSite Strict</li>
          <li>Protección CSRF en mutaciones</li>
          <li>Sesiones revocables</li>
          <li>Agente local con token independiente</li>
          <li>Credenciales de publicación únicamente en la PC</li>
          <li>Publicaciones inciertas requieren revisión manual</li>
        </ul>
      </Card>
    </section>
  );
}

function CommandTable({ items, onOpen }: { items: CommandRecord[]; onOpen?: (item: CommandRecord) => void }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Creado</th><th>Trabajo</th><th>Estado</th><th>Etapa</th><th>Progreso</th></tr></thead>
        <tbody>
          {items.map((command) => (
            <tr key={command.id} onClick={() => onOpen?.(command)} className={onOpen ? "clickable" : ""}>
              <td>{shortDate(command.createdAt)}</td>
              <td><strong className="command-name">{commandLabel(command.type)}</strong><small className="command-code">{command.type}</small></td>
              <td><Badge status={command.status} /></td>
              <td>{humanize(command.currentStage || "Esperando agente")}</td>
              <td><div className="progress-cell"><div><span style={{ width: `${Math.max(0, Math.min(100, command.progressPercent ?? 0))}%` }} /></div><small>{command.progressPercent ?? 0}%</small></div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HealthRow({ label, value, good }: { label: string; value: string; good: boolean }) {
  return <div><span><StatusDot online={good} />{label}</span><strong>{value}</strong></div>;
}

function NavIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    home: "M3 10.8 12 3l9 7.8V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z",
    "manual-news": "M5 3h10l4 4v14H5zM15 3v5h5M9 13h6M12 10v6",
    news: "M4 4h16v16H4zM8 8h8M8 12h8M8 16h5",
    scraper: "M4 6h16M7 12h10M10 18h4",
    video: "M4 5h12v14H4zM16 10l4-3v10l-4-3z",
    automation: "M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
    queue: "M4 6h16M4 12h16M4 18h10",
    audit: "M6 3h12v18H6zM9 8h6m-6 4h6m-6 4h4",
    security: "M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6Z",
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>;
}

function normalizeItems(value: unknown): ContentItem[] {
  if (Array.isArray(value)) return value.filter(isObject);
  if (!isObject(value)) return [];
  for (const key of ["items", "jobs", "pending", "articles"]) if (Array.isArray(value[key])) return value[key].filter(isObject);
  return [];
}

function uniqueLines(value: string) {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
}

function videoMime(file: File): "video/mp4" | "video/quicktime" | "video/x-m4v" | "video/webm" | null {
  const declared = file.type.split(";")[0]!.trim().toLowerCase();
  if (["video/mp4", "video/quicktime", "video/x-m4v", "video/webm"].includes(declared)) {
    return declared as "video/mp4" | "video/quicktime" | "video/x-m4v" | "video/webm";
  }
  const extension = file.name.toLowerCase().split(".").pop();
  return extension === "webm" ? "video/webm"
    : extension === "mov" ? "video/quicktime"
      : extension === "m4v" ? "video/x-m4v"
        : extension === "mp4" ? "video/mp4"
          : null;
}

function isObject(value: unknown): value is ContentItem {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function confirmed(value: string) {
  return window.confirm(value);
}

function humanize(value: unknown) {
  return String(value ?? "—").replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
