/* eslint-disable react-refresh/only-export-components */
import type { SyntheticEvent } from "react";
import type { CommandRecord, CommandType } from "../../../packages/contracts/src/index";

export type RunCommand = (
  type: CommandType,
  payload: Record<string, unknown>,
  success?: string,
) => Promise<CommandRecord | null>;

export type SnapshotMap = Record<string, any>;
export type ContentItem = Record<string, any>;
export type ViewMode = "card" | "compact";

export const PLATFORM_OPTIONS = [
  { key: "web", label: "WordPress" },
  { key: "instagram", label: "Instagram" },
  { key: "facebook", label: "Facebook" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "x", label: "X" },
] as const;

export const SOURCE_OPTIONS = [
  { key: "all", label: "Todas las fuentes" },
  { key: "minutouno", label: "MinutoUno" },
  { key: "tn", label: "TN" },
  { key: "na", label: "Noticias Argentinas" },
  { key: "ambito", label: "Ámbito" },
  { key: "aries", label: "Aries" },
  { key: "justicia", label: "Justicia Salta" },
  { key: "fiscales", label: "Fiscales Penales" },
  { key: "nuevodiario", label: "Nuevo Diario" },
  { key: "elonce", label: "Elonce" },
  { key: "eloncesalta", label: "Elonce Salta" },
  { key: "eltribuno", label: "El Tribuno" },
  { key: "infobae", label: "Infobae" },
  { key: "quepasasalta", label: "Qué Pasa Salta" },
] as const;

const SOURCE_LABELS = Object.fromEntries(SOURCE_OPTIONS.map((source) => [source.key, source.label]));
const SENSITIVE_KEY = /password|secret|token|cookie|authorization|credential|hash/i;

export function sourceLabel(value: unknown) {
  const source = String(value || "").toLowerCase();
  const aliases: Record<string, string> = {
    noticiasargentinas: "Noticias Argentinas",
    ariesonline: "Aries",
    justiciasalta: "Justicia Salta",
    nuevodiariodesalta: "Nuevo Diario",
  };
  return SOURCE_LABELS[source] ?? aliases[source] ?? (source || "Sin fuente");
}

export function extractArticles(result: unknown): ContentItem[] {
  if (Array.isArray(result)) return result.filter(isRecord);
  if (!isRecord(result)) return [];
  for (const key of ["articles", "items", "noticias", "posts"]) {
    if (Array.isArray(result[key])) return result[key].filter(isRecord);
  }
  return [];
}

export function articleTitle(item: ContentItem) {
  return String(item.titulo ?? item.title ?? "Sin título").trim() || "Sin título";
}

export function articleUrl(item: ContentItem) {
  return String(item.web_url ?? item.url_wordpress ?? item.url ?? "").trim();
}

export function articleImage(item: ContentItem) {
  return String(
    item.preview_image_url
    ?? item.imagen_optimizada
    ?? item.imagen
    ?? item.image
    ?? item.thumbnail
    ?? "",
  ).trim();
}

export function articleExcerpt(item: ContentItem) {
  const direct = String(item.extracto ?? item.excerpt ?? item.descripcion ?? "").trim();
  if (direct) return stripHtml(direct);
  if (Array.isArray(item.parrafos)) return item.parrafos.map(String).join(" ").slice(0, 320);
  return "";
}

export function articleParagraphs(item: ContentItem): string[] {
  for (const candidate of [item.parrafos, item.paragraphs, item.contenido, item.content]) {
    if (Array.isArray(candidate)) {
      const paragraphs = candidate.map((value) => stripHtml(String(value))).map((value) => value.trim()).filter(Boolean);
      if (paragraphs.length) return paragraphs;
    }
    if (typeof candidate === "string" && candidate.trim()) {
      const paragraphs = candidate
        .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .split(/\n\s*\n|\r?\n/)
        .map((value) => stripHtml(value).trim())
        .filter(Boolean);
      if (paragraphs.length) return paragraphs;
    }
  }
  const excerpt = articleExcerpt(item);
  return excerpt ? [excerpt] : [];
}

export function articleBody(item: ContentItem) {
  return articleParagraphs(item).join("\n\n");
}

export function articleAge(item: ContentItem, now = Date.now()) {
  const relativeText = String(item.fecha_texto ?? "").trim();
  if (/^hace\s+/i.test(relativeText)) return relativeText.charAt(0).toUpperCase() + relativeText.slice(1);
  const candidates = [
    item.fecha_publicacion,
    item.published_at,
    item.date,
    item.fecha,
    item.fecha_texto,
    item.fecha_hora,
    item.timestamp,
    item.created_at,
    item.updated_at,
  ];
  for (const candidate of candidates) {
    const timestamp = parseTimestamp(candidate);
    if (timestamp !== null) return relativeAge(timestamp, now);
  }
  const urlMatch = articleUrl(item).match(/\/(20\d{2})\/(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])(?:\/|$)/);
  if (urlMatch) {
    const timestamp = Date.UTC(Number(urlMatch[1]), Number(urlMatch[2]) - 1, Number(urlMatch[3]));
    return relativeAge(timestamp, now);
  }
  return "Fecha no disponible";
}

export function relativeAge(timestamp: number, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return "Hace menos de 1 min";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Hace ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `Hace ${days} día${days === 1 ? "" : "s"}`;
  const months = Math.floor(days / 30);
  if (months < 12) return `Hace ${months} mes${months === 1 ? "" : "es"}`;
  const years = Math.floor(days / 365);
  return `Hace ${years} año${years === 1 ? "" : "s"}`;
}

export function shortDate(value?: string | number | null) {
  if (value === undefined || value === null || value === "") return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("es-AR");
}

export function statusLabel(status: string) {
  return ({
    queued: "En cola",
    claimed: "Asignado",
    running: "Ejecutando",
    completed: "Completado",
    partial_success: "Éxito parcial",
    completed_unverified: "Sin verificar",
    waiting_manual_retry: "Reintento manual",
    requires_attention: "Requiere atención",
    failed: "Fallido",
    cancelled: "Cancelado",
    success: "Correcto",
    healthy: "Saludable",
    ready: "Listo",
    processing: "Procesando",
    pending: "Pendiente",
    uploading: "Subiendo",
    error: "Error recuperable",
    cleanup_error: "Limpieza pendiente",
    offline: "Desconectado",
  } as Record<string, string>)[status] ?? status;
}

export function commandLabel(type: string) {
  return ({
    "snapshot.refresh": "Sincronizar estado",
    "scraper.titles": "Buscar titulares",
    "scraper.details": "Preparar artículos",
    "scraper.clear": "Limpiar scraper",
    "scraper.all.titles": "Buscar en todas las fuentes",
    "scraper.all.details": "Preparar selección combinada",
    "news.load_wordpress": "Traer desde WordPress",
    "news.save": "Guardar noticias",
    "news.clear_cache": "Vaciar noticias",
    "news.publish": "Publicar noticias",
    "publish.clear": "Limpiar historial de publicación",
    "automation.start": "Iniciar automatización",
    "automation.stop": "Detener automatización",
    "automation.restart": "Reiniciar automatización",
    "automation.job.cancel": "Cancelar trabajo local",
    "automation.jobs.clear": "Limpiar trabajos locales",
    "instagram.pending.retry": "Reintentar Instagram",
    "instagram.pending.delete": "Eliminar pendiente de Instagram",
    "whatsapp.groups.extract": "Actualizar grupos de WhatsApp",
    "whatsapp.group_set.save": "Guardar conjunto de WhatsApp",
    "xvideo.create_url": "Procesar video",
    "xvideo.create_upload": "Procesar video cargado",
    "xvideo.update": "Editar video",
    "xvideo.share_test": "Enviar video al grupo de prueba",
    "xvideo.batch.create": "Procesar lote de videos",
    "xvideo.batch.publish": "Publicar lote de videos",
    "xvideo.publish": "Publicar video",
    "xvideo.clear_cache": "Limpiar caché de videos",
    "xvideo.clear_jobs": "Limpiar trabajos de video",
    "xvideo.export_r2": "Subir video a R2",
    "wordpress.share": "Compartir post de WordPress",
  } as Record<string, string>)[type] ?? type;
}

export function Card({ title, eyebrow, actions, children, className = "" }: any) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          <div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}{title && <h2>{title}</h2>}</div>
          {actions && <div className="actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({ label, hint, children }: any) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function Badge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{statusLabel(status)}</span>;
}

export function StatusDot({ online }: { online: boolean }) {
  return <span className={`dot ${online ? "online" : "offline"}`} />;
}

export function Empty({ text, detail }: { text: string; detail?: string }) {
  return <div className="empty"><strong>{text}</strong>{detail && <span>{detail}</span>}</div>;
}

export type OpsAlert = { id: string; tone: "critical" | "warning"; message: string };

const PLATFORM_LABELS: Record<string, string> = { whatsapp: "WhatsApp", x: "X" };
// A job that's been "actively" processing for this long without its
// updated_at moving is more likely stuck than genuinely still working —
// mirrors the kind of stall found in the WhatsApp publish pipeline in
// practice (a job sitting at 95% for well over an hour).
const STALE_JOB_MS = 20 * 60 * 1000;

function toItems(payload: unknown): ContentItem[] {
  if (Array.isArray(payload)) return payload.filter((item) => item && typeof item === "object");
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  for (const key of ["items", "jobs", "pending", "articles"]) {
    if (Array.isArray(record[key])) return (record[key] as unknown[]).filter((item) => item && typeof item === "object") as ContentItem[];
  }
  return [];
}

/**
 * Derives operator-facing alerts purely from data the dashboard already
 * polls every few seconds (no extra backend calls). Surfaces the silent
 * failure modes that otherwise only show up if someone happens to open the
 * right tab: the bridge PC being unreachable, WhatsApp/X needing a manual
 * QR re-login, a worker stuck in an error state, Instagram posts waiting on
 * manual review, and local jobs that stopped making progress.
 */
export function computeOpsAlerts(dashboard: any, snapshots: SnapshotMap): OpsAlert[] {
  const agentOnline = Boolean(dashboard?.agent?.online);
  if (!agentOnline) {
    return [{ id: "agent-offline", tone: "critical", message: "El agente local está desconectado: nada se está preparando ni publicando en este momento." }];
  }

  const alerts: OpsAlert[] = [];
  const status = snapshots["automation.status"]?.payload ?? {};
  const runtimeStatus = String(status?.status ?? "unknown");
  if (!["running", "healthy"].includes(runtimeStatus)) {
    alerts.push({ id: "runtime-stopped", tone: "warning", message: "La automatización local (WhatsApp/X) está detenida." });
  }

  const platforms = status?.platforms ?? {};
  for (const key of Object.keys(PLATFORM_LABELS)) {
    const platform = platforms?.[key];
    if (!platform) continue;
    const label = PLATFORM_LABELS[key];
    if (platform.needs_auth) {
      alerts.push({ id: `${key}-needs-auth`, tone: "critical", message: `${label} necesita reautenticación manual (escanear QR/iniciar sesión) para poder publicar.` });
    } else if (["error", "degraded"].includes(String(platform.worker_status))) {
      alerts.push({
        id: `${key}-worker-error`,
        tone: "warning",
        message: `El worker de ${label} está en estado "${platform.worker_status}"${platform.last_error ? `: ${platform.last_error}` : "."}`,
      });
    }
  }

  const pendingCount = toItems(snapshots["instagram.pending"]?.payload).length;
  if (pendingCount > 0) {
    alerts.push({ id: "ig-pending", tone: "warning", message: `Hay ${pendingCount} publicación(es) de Instagram pendiente(s) de revisión manual.` });
  }

  const now = Date.now();
  const staleJobs = toItems(snapshots["automation.jobs"]?.payload).filter((job) => {
    if (!["publishing", "processing", "preparing", "enhancing"].includes(String(job.status))) return false;
    const updated = parseTimestamp(job.updated_at);
    return updated !== null && now - updated > STALE_JOB_MS;
  });
  if (staleJobs.length > 0) {
    alerts.push({
      id: "stale-jobs",
      tone: "warning",
      message: `${staleJobs.length} trabajo(s) local(es) llevan más de 20 minutos sin avanzar; revise la pestaña Automatización.`,
    });
  }

  return alerts;
}

export function AlertBanner({ alerts }: { alerts: OpsAlert[] }) {
  if (!alerts.length) return null;
  return (
    <div className="ops-alert-stack">
      {alerts.map((alert) => (
        <div key={alert.id} className={`alert ${alert.tone === "critical" ? "error" : "warning"}`}>
          {alert.message}
        </div>
      ))}
    </div>
  );
}

export function Stat({ label, value, tone = "neutral", detail }: any) {
  return <div className={`stat ${tone}`}><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;
}

export function Progress({ command }: { command?: CommandRecord | null }) {
  if (!command) return null;
  const percent = Math.max(0, Math.min(100, command.progressPercent ?? 0));
  return (
    <div className="command-progress">
      <div><span style={{ width: `${percent}%` }} /></div>
      <p><Badge status={command.status} /><span>{stageLabel(command.currentStage || "queued")}</span><strong>{percent}%</strong></p>
      {command.errorMessage && <div className="inline-error">{command.errorMessage}</div>}
    </div>
  );
}

export function TechnicalDetails({ value, label = "Ver datos técnicos" }: { value: unknown; label?: string }) {
  return (
    <details className="technical">
      <summary>{label}</summary>
      <pre>{JSON.stringify(redact(value), null, 2)}</pre>
    </details>
  );
}

export function ReadableData({ value, empty = "Sin datos disponibles" }: { value: unknown; empty?: string }) {
  if (!isRecord(value)) return <Empty text={empty} />;
  const entries = Object.entries(value).filter(([key, item]) => !SENSITIVE_KEY.test(key) && item !== null && item !== undefined);
  if (!entries.length) return <Empty text={empty} />;
  return (
    <div className="data-grid">
      {entries.slice(0, 16).map(([key, item]) => (
        <div className="data-row" key={key}>
          <span>{humanizeKey(key)}</span>
          <strong>{formatValue(item)}</strong>
        </div>
      ))}
    </div>
  );
}

export function ResultSummary({ command }: { command?: CommandRecord | null }) {
  if (!command) return null;
  const result = command.result;
  const articles = extractArticles(result);
  if (articles.length) {
    return <div className="result-summary"><strong>{articles.length} elementos obtenidos</strong><span>Resultado asociado al trabajo {command.id.slice(0, 8)}</span></div>;
  }
  if (isRecord(result)) return <ReadableData value={result} />;
  return <div className="result-summary"><strong>{statusLabel(command.status)}</strong><span>{result ? String(result) : "Sin información adicional"}</span></div>;
}

export function ArticleList({
  items,
  selected,
  onToggle,
  view,
  editable = false,
  onChange,
}: {
  items: Array<{ index: number; item: ContentItem }>;
  selected: number[];
  onToggle(index: number): void;
  view: ViewMode;
  editable?: boolean;
  onChange?: (index: number, item: ContentItem) => void;
}) {
  if (!items.length) return <Empty text="No hay artículos para mostrar" detail="Ejecutá la etapa anterior para obtener resultados." />;
  return (
    <div className={`article-list view-${view}`}>
      {items.map(({ index, item }) => {
        const checked = selected.includes(index);
        const image = articleImage(item);
        const body = articleBody(item);
        const stopToggle = (event: SyntheticEvent) => event.stopPropagation();
        return (
          <article
            key={`${articleUrl(item) || articleTitle(item)}-${index}`}
            className={`${checked ? "selected" : ""} ${editable ? "editable" : ""}`.trim()}
            role="checkbox"
            aria-checked={checked}
            tabIndex={0}
            onClick={() => onToggle(index)}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggle(index); } }}
          >
            <button className="article-select" onClick={(event) => { stopToggle(event); onToggle(index); }} aria-label={checked ? "Quitar selección" : "Seleccionar"} tabIndex={-1}>
              <span>{checked ? "✓" : ""}</span>
            </button>
            <div className="article-media">
              {image
                ? <img src={image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.style.display = "none"; }} />
                : <div className="media-fallback">{sourceLabel(item.source).slice(0, 2).toUpperCase()}</div>}
            </div>
            <div className="article-copy">
              <div className="article-meta"><span>{sourceLabel(item.source)}</span><time>{articleAge(item)}</time></div>
              {editable ? (
                <>
                  <input className="article-title-input" value={articleTitle(item)} onClick={stopToggle} onChange={(event) => onChange?.(index, { ...item, titulo: event.target.value, manual_override: true })} />
                  <label className="article-editor-field" onClick={stopToggle}><span>Extracto</span><textarea value={articleExcerpt(item)} rows={3} onChange={(event) => onChange?.(index, { ...item, extracto: event.target.value, manual_override: true })} /></label>
                  <label className="article-editor-field" onClick={stopToggle}><span>Contenido completo</span><textarea className="article-content-input" value={body} rows={10} onChange={(event) => onChange?.(index, { ...item, parrafos: splitParagraphs(event.target.value), manual_override: true })} /></label>
                </>
              ) : (
                <>
                  <h3>{articleTitle(item)}</h3>
                  {body && <div className="article-body">{articleParagraphs(item).map((paragraph, paragraphIndex) => <p key={paragraphIndex}>{paragraph}</p>)}</div>}
                </>
              )}
              {articleUrl(item) && <a href={articleUrl(item)} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>Abrir fuente ↗</a>}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function splitParagraphs(value: string) {
  return value.split(/\n\s*\n|\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
}

export function PlatformChooser({ selected, onChange, allowed }: { selected: string[]; onChange(next: string[]): void; allowed?: string[] }) {
  return (
    <div className="platform-grid">
      {PLATFORM_OPTIONS.filter((platform) => !allowed || allowed.includes(platform.key)).map((platform) => {
        const active = selected.includes(platform.key);
        return (
          <button type="button" className={active ? "active" : ""} key={platform.key} onClick={() => onChange(active ? selected.filter((key) => key !== platform.key) : [...selected, platform.key])}>
            <span>{active ? "✓" : "+"}</span>{platform.label}
          </button>
        );
      })}
    </div>
  );
}

export function ReviewModal({
  open,
  title,
  items,
  platforms,
  groups,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  items: ContentItem[];
  platforms: string[];
  groups: ContentItem[];
  busy?: boolean;
  onClose(): void;
  onConfirm(): void;
}) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal review-modal" onClick={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>×</button>
        <p className="eyebrow">Confirmación final</p>
        <h2>{title}</h2>
        <div className="review-stats">
          <Stat label="Artículos" value={items.length} />
          <Stat label="Destinos" value={platforms.length} />
          <Stat label="Grupos WhatsApp" value={groups.length} />
        </div>
        <div className="review-destinations">{platforms.map((platform) => <span key={platform}>{PLATFORM_OPTIONS.find((item) => item.key === platform)?.label ?? platform}</span>)}</div>
        <div className="review-items">{items.slice(0, 12).map((item, index) => <div key={`${articleTitle(item)}-${index}`}><strong>{articleTitle(item)}</strong><small>{sourceLabel(item.source)} · {articleAge(item)}</small></div>)}</div>
        {items.length > 12 && <p className="muted">Y {items.length - 12} artículos más.</p>}
        <div className="actions modal-actions"><button onClick={onClose}>Volver</button><button className="primary" disabled={busy} onClick={onConfirm}>{busy ? "Encolando…" : "Confirmar publicación"}</button></div>
      </section>
    </div>
  );
}

export function toggleIndex(current: number[], index: number) {
  return current.includes(index) ? current.filter((item) => item !== index) : [...current, index];
}

export function isActive(command?: CommandRecord | null) {
  return Boolean(command && ["queued", "claimed", "running"].includes(command.status));
}

export function isTerminalSuccess(command?: CommandRecord | null) {
  return Boolean(command && ["completed", "partial_success", "completed_unverified"].includes(command.status));
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value !== "string" || !value.trim()) return null;
  const direct = Date.parse(value);
  if (!Number.isNaN(direct)) return direct;
  const match = value.match(/(\d{1,2})[/-](\d{1,2})[/-](20\d{2})/);
  if (match) return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1])).getTime();
  const spanish = value.toLocaleLowerCase("es").match(/(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+de\s+(20\d{2})/);
  if (!spanish) return null;
  const months = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  return new Date(Number(spanish[3]), months.indexOf(spanish[2]), Number(spanish[1])).getTime();
}

function stripHtml(value: string) {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function formatValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `${value.length} elemento${value.length === 1 ? "" : "s"}`;
  if (isRecord(value)) {
    const status = value.status ?? value.state ?? value.session_status;
    return status ? statusLabel(String(status)) : `${Object.keys(value).length} propiedades`;
  }
  return "—";
}

function humanizeKey(value: string) {
  return value.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

// Some stages (currently only the video publish stage) carry an already
// human-readable, specific message after a "prefix:" marker — e.g.
// "video_publish:Instagram: procesando video (intento 12/60)" — instead of
// a plain machine key. Detect and pass those through verbatim instead of
// running them through humanizeKey's blunt per-word capitalization.
export function stageLabel(value: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const prefixed = raw.match(/^[a-z_]+:(.+)$/s);
  if (prefixed) return prefixed[1].trim();
  return humanizeKey(raw);
}

export function MiniProgressBar({ label, percent, indeterminate = false }: { label: string; percent?: number; indeterminate?: boolean }) {
  const pct = Math.max(0, Math.min(100, percent ?? 0));
  return (
    <div className={`mini-progress${indeterminate ? " indeterminate" : ""}`} role="status">
      <div><span style={indeterminate ? undefined : { width: `${pct}%` }} /></div>
      <p><span>{label}</span>{!indeterminate && <strong>{Math.round(pct)}%</strong>}</p>
    </div>
  );
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTADO]" : redact(item)]));
}
