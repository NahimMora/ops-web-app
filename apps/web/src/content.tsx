/* eslint-disable react-refresh/only-export-components */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { CommandRecord } from "../../../packages/contracts/src/index";
import {
  buildManualNewsItem,
  EMPTY_MANUAL_NEWS_DRAFT,
  validateManualNewsDraft,
  type ManualNewsDraft,
} from "./manual-news";
import {
  ArticleList,
  Card,
  Empty,
  Field,
  PlatformChooser,
  Progress,
  ResultSummary,
  ReviewModal,
  SOURCE_OPTIONS,
  TechnicalDetails,
  articleExcerpt,
  articleImage,
  articleTitle,
  articleUrl,
  extractArticles,
  isActive,
  isTerminalSuccess,
  shortDate,
  sourceLabel,
  toggleIndex,
  type ContentItem,
  type RunCommand,
  type SnapshotMap,
  type ViewMode,
} from "./ui";

type ContentProps = {
  commands: CommandRecord[];
  snapshots: SnapshotMap;
  run: RunCommand;
};

const DEFAULT_PLATFORMS = ["web", "instagram", "facebook", "x"];

export function Scrapers({ commands, snapshots, run }: ContentProps) {
  const [source, setSource] = useState("all");
  const [max, setMax] = useState(20);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<ViewMode>(() => readView("ops:scrapers:view"));
  const [titleCommandId, setTitleCommandId] = useState("");
  const [detailCommandId, setDetailCommandId] = useState("");
  const [publishCommandId, setPublishCommandId] = useState("");
  const [clearCommandId, setClearCommandId] = useState("");
  const [selectedTitles, setSelectedTitles] = useState<number[]>([]);
  const [processed, setProcessed] = useState<ContentItem[]>([]);
  const [selectedProcessed, setSelectedProcessed] = useState<number[]>([]);
  const [platforms, setPlatforms] = useState<string[]>(DEFAULT_PLATFORMS);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [selectedGroupSet, setSelectedGroupSet] = useState<ContentItem | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const hydratedDetails = useRef("");
  const finishedPublication = useRef("");
  const finishedClear = useRef("");

  const latestClearCommand = commands.find((command) => {
    if (command.type !== "scraper.clear" || !isTerminalSuccess(command)) return false;
    const clearedSource = String(command.payload.source || "");
    return source === "all" || clearedSource === "all" || clearedSource === source;
  });
  const latestTitleCandidate = commands.find((command) => {
    if (source === "all") return command.type === "scraper.all.titles" && Boolean(command.result);
    return command.type === "scraper.titles" && command.payload.source === source && Boolean(command.result);
  });
  const titleCandidate = commands.find((command) => command.id === titleCommandId) ?? (!titleCommandId ? latestTitleCandidate : undefined);
  const titleCommand = titleCandidate && (!latestClearCommand || Date.parse(titleCandidate.createdAt) > Date.parse(latestClearCommand.createdAt)) ? titleCandidate : undefined;
  const detailCommand = commands.find((command) => command.id === detailCommandId);
  const publishCommand = commands.find((command) => command.id === publishCommandId);
  const clearCommand = commands.find((command) => command.id === clearCommandId);

  const titles = useMemo(
    () => extractArticles(titleCommand?.result).map((item) => ({ ...item, source: item.source || source })),
    [source, titleCommand?.result],
  );
  const filteredTitles = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("es");
    return titles.map((item, index) => ({ item, index })).filter(({ item }) => !term || `${articleTitle(item)} ${articleExcerpt(item)} ${sourceLabel(item.source)}`.toLocaleLowerCase("es").includes(term));
  }, [search, titles]);
  const processedRows = useMemo(() => processed.map((item, index) => ({ item, index })), [processed]);
  const selectedItems = selectedProcessed.map((index) => processed[index]).filter(Boolean);
  const groups = normalizeGroups(snapshots["whatsapp.groups"]?.payload);
  const selectedGroups = resolveSelectedGroups(groups, selectedGroupIds, selectedGroupSet);

  useEffect(() => {
    localStorage.setItem("ops:scrapers:view", view);
  }, [view]);

  useEffect(() => {
    if (!detailCommand?.result || detailCommand.id === hydratedDetails.current || !isTerminalSuccess(detailCommand)) return;
    const items = extractArticles(detailCommand.result);
    hydratedDetails.current = detailCommand.id;
    setProcessed(items);
    setSelectedProcessed(items.map((_, index) => index));
  }, [detailCommand]);

  useEffect(() => {
    if (!publishCommand || publishCommand.id === finishedPublication.current || !isTerminalSuccess(publishCommand)) return;
    finishedPublication.current = publishCommand.id;
    setSelectedProcessed([]);
  }, [publishCommand]);

  useEffect(() => {
    if (!clearCommand || clearCommand.id === finishedClear.current || !isTerminalSuccess(clearCommand)) return;
    finishedClear.current = clearCommand.id;
    setTitleCommandId("");
    setDetailCommandId("");
    setSelectedTitles([]);
    setProcessed([]);
    setSelectedProcessed([]);
    setPublishCommandId("");
  }, [clearCommand]);

  async function handleSearch() {
    setClearCommandId("");
    setSelectedTitles([]);
    setProcessed([]);
    setSelectedProcessed([]);
    setDetailCommandId("");
    setPublishCommandId("");
    const command = source === "all"
      ? await run("scraper.all.titles", { maxArticlesPerSource: Math.min(max, 50) }, "Búsqueda en todas las fuentes encolada")
      : await run("scraper.titles", { source, maxArticles: max }, `Búsqueda de ${sourceLabel(source)} encolada`);
    if (command) setTitleCommandId(command.id);
  }

  async function handleClear() {
    const target = source === "all" ? "todas las fuentes" : sourceLabel(source);
    if (!confirmed(`¿Limpiar títulos e historial de ${target}? Las noticias preparadas no se borrarán.`)) return;
    const command = await run("scraper.clear", { source }, `Limpieza de ${target} encolada`);
    if (command) setClearCommandId(command.id);
  }

  async function handlePrepare() {
    const chosen = selectedTitles.map((index) => titles[index]).filter(Boolean);
    if (!chosen.length) return;
    setProcessed([]);
    setSelectedProcessed([]);
    const command = source === "all"
      ? await run("scraper.all.details", {
          items: chosen.map((item) => ({ source: String(item.source), url: articleUrl(item) })),
        }, "Procesamiento combinado encolado")
      : await run("scraper.details", {
          source,
          urls: chosen.map(articleUrl),
        }, "Procesamiento de artículos encolado");
    if (command) setDetailCommandId(command.id);
  }

  async function handlePublish() {
    if (!selectedItems.length || !platforms.length) return;
    if (platforms.includes("whatsapp") && !selectedGroups.length) return;
    setReviewOpen(false);
    const command = await run("news.publish", {
      selectedIndices: [],
      directNewsItems: selectedItems,
      platforms,
      whatsappGroups: selectedGroups,
      whatsappGroupSet: selectedGroupSet,
      instagramEmojis: true,
    }, "Publicación encolada");
    if (command) setPublishCommandId(command.id);
  }

  const searchBusy = isActive(titleCommand);
  const processBusy = isActive(detailCommand);
  const publishBusy = isActive(publishCommand);
  const clearBusy = isActive(clearCommand);

  return (
    <div className="flow-page">
      <FlowSteps
        steps={[
          { label: "Buscar", complete: titles.length > 0, active: !titles.length },
          { label: "Preparar", complete: processed.length > 0, active: titles.length > 0 && !processed.length },
          { label: "Publicar", complete: isTerminalSuccess(publishCommand), active: processed.length > 0 },
        ]}
      />

      <Card title="1. Buscar titulares" eyebrow="Descubrimiento" actions={<ViewToggle value={view} onChange={setView} />}>
        <div className="scraper-toolbar">
          <Field label="Fuente">
            <select value={source} onChange={(event) => {
              setSource(event.target.value);
              setTitleCommandId("");
              setClearCommandId("");
              setDetailCommandId("");
              setSelectedTitles([]);
              setProcessed([]);
              setSelectedProcessed([]);
            }}>
              {SOURCE_OPTIONS.map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}
            </select>
          </Field>
          <Field label={source === "all" ? "Máximo por fuente" : "Máximo de titulares"}>
            <input type="number" min={1} max={source === "all" ? 50 : 100} value={max} onChange={(event) => setMax(Math.max(1, Number(event.target.value) || 1))} />
          </Field>
          <Field label="Filtrar resultados">
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por título o medio…" />
          </Field>
          <button className="danger-ghost toolbar-submit" disabled={clearBusy || searchBusy || processBusy} onClick={() => void handleClear()}>
            {clearBusy ? "Limpiando…" : source === "all" ? "Limpiar todas" : "Limpiar esta fuente"}
          </button>
          <button className="primary toolbar-submit" disabled={clearBusy || searchBusy || processBusy} onClick={() => void handleSearch()}>
            {searchBusy ? "Buscando…" : "Buscar noticias"}
          </button>
        </div>
        <Progress command={clearCommand} />
        <Progress command={titleCommand} />
        {titles.length > 0 && (
          <SelectionBar
            shown={filteredTitles.map(({ index }) => index)}
            selected={selectedTitles}
            label={`${titles.length} titulares · ${selectedTitles.length} seleccionados`}
            onChange={setSelectedTitles}
          />
        )}
        <ArticleList items={filteredTitles} selected={selectedTitles} onToggle={(index) => setSelectedTitles((current) => toggleIndex(current, index))} view={view} />
        {titleCommand?.result && <TechnicalDetails value={titleCommand.result} label="Ver respuesta técnica de la búsqueda" />}
      </Card>

      <Card
        title="2. Preparar y editar"
        eyebrow="Procesamiento local"
        actions={<button className="primary" disabled={!selectedTitles.length || processBusy || searchBusy} onClick={() => void handlePrepare()}>{processBusy ? "Preparando artículos…" : `Preparar ${selectedTitles.length || ""} seleccionados`}</button>}
      >
        <p className="card-intro">La PC descarga el contenido y las imágenes únicamente de los titulares seleccionados. Al terminar, podés corregir título y extracto en esta misma pantalla.</p>
        <div className={`stage-status ${processBusy ? "working" : processed.length ? "ready" : "waiting"}`}>
          <strong>{processBusy ? "Preparando el contenido completo" : processed.length ? `${processed.length} artículos listos para publicar` : selectedTitles.length ? `${selectedTitles.length} titulares pendientes de preparar` : "Todavía no hay titulares para preparar"}</strong>
          <span>{processBusy ? "Se están descargando los párrafos y las imágenes. La selección quedará lista automáticamente." : processed.length ? "Ya puede editar todos los párrafos o continuar a Publicar; todos quedaron seleccionados." : selectedTitles.length ? "Presione Preparar seleccionados para descargar cada artículo." : "Busque titulares y seleccione los que quiera procesar."}</span>
        </div>
        <Progress command={detailCommand} />
        {processed.length > 0 && (
          <SelectionBar
            shown={processedRows.map(({ index }) => index)}
            selected={selectedProcessed}
            label={`${processed.length} preparados · ${selectedProcessed.length} para publicar`}
            onChange={setSelectedProcessed}
          />
        )}
        <ArticleList
          items={processedRows}
          selected={selectedProcessed}
          onToggle={(index) => setSelectedProcessed((current) => toggleIndex(current, index))}
          view={view}
          editable
          onChange={(index, item) => setProcessed((current) => current.map((existing, currentIndex) => currentIndex === index ? item : existing))}
        />
        {detailCommand?.result && <TechnicalDetails value={detailCommand.result} label="Ver respuesta técnica del procesamiento" />}
      </Card>

      <Card title="3. Revisar y publicar" eyebrow="Distribución">
        <p className="card-intro">Elegí WordPress y las redes donde querés distribuir los artículos seleccionados.</p>
        <PlatformChooser selected={platforms} onChange={setPlatforms} />
        {platforms.includes("whatsapp") && (
          <WhatsAppSelector
            snapshots={snapshots}
            selectedIds={selectedGroupIds}
            selectedSet={selectedGroupSet}
            onSelectedIds={setSelectedGroupIds}
            onSelectedSet={setSelectedGroupSet}
            run={run}
          />
        )}
        {platforms.includes("whatsapp") && !selectedGroups.length && <div className="inline-warning">Seleccioná al menos un grupo de WhatsApp antes de publicar.</div>}
        <div className="publish-footer">
          <div><strong>{selectedItems.length} artículos listos</strong><span>{platforms.length} destinos seleccionados</span></div>
          <button className="primary publish-button" disabled={!selectedItems.length || !platforms.length || publishBusy || (platforms.includes("whatsapp") && !selectedGroups.length)} onClick={() => setReviewOpen(true)}>
            {publishBusy ? "Publicando…" : "Revisar publicación"}
          </button>
        </div>
        <Progress command={publishCommand} />
        {publishCommand && !isActive(publishCommand) && <ResultSummary command={publishCommand} />}
        {publishCommand?.result && <TechnicalDetails value={publishCommand.result} label="Ver detalle técnico de la publicación" />}
      </Card>

      <ReviewModal
        open={reviewOpen}
        title="Publicar artículos seleccionados"
        items={selectedItems}
        platforms={platforms}
        groups={selectedGroups}
        busy={publishBusy}
        onClose={() => setReviewOpen(false)}
        onConfirm={() => void handlePublish()}
      />
    </div>
  );
}

export function ManualNews({ commands, snapshots, run }: ContentProps) {
  const [draft, setDraft] = useState<ManualNewsDraft>({ ...EMPTY_MANUAL_NEWS_DRAFT });
  const [platforms, setPlatforms] = useState<string[]>(DEFAULT_PLATFORMS);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [selectedGroupSet, setSelectedGroupSet] = useState<ContentItem | null>(null);
  const [reviewItem, setReviewItem] = useState<ContentItem | null>(null);
  const [publishCommandId, setPublishCommandId] = useState("");
  const [formError, setFormError] = useState("");

  const groups = normalizeGroups(snapshots["whatsapp.groups"]?.payload);
  const selectedGroups = resolveSelectedGroups(groups, selectedGroupIds, selectedGroupSet);
  const publishCommand = commands.find((command) => command.id === publishCommandId);
  const preview = buildManualNewsItem(draft);

  function update<K extends keyof ManualNewsDraft>(key: K, value: ManualNewsDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setFormError("");
  }

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const error = validateManualNewsDraft(draft);
    if (error) {
      setFormError(error);
      return;
    }
    if (!platforms.length) {
      setFormError("Elegí al menos un destino de publicación.");
      return;
    }
    if (platforms.includes("whatsapp") && !selectedGroups.length) {
      setFormError("Elegí al menos un grupo para publicar en WhatsApp.");
      return;
    }
    setReviewItem(buildManualNewsItem(draft));
  }

  async function publish() {
    if (!reviewItem || !platforms.length) return;
    setReviewItem(null);
    const command = await run("news.publish", {
      selectedIndices: [],
      directNewsItems: [reviewItem],
      platforms,
      whatsappGroups: selectedGroups,
      whatsappGroupSet: selectedGroupSet,
      instagramEmojis: true,
    }, "Publicación manual encolada");
    if (command) setPublishCommandId(command.id);
  }

  function reset() {
    setDraft({ ...EMPTY_MANUAL_NEWS_DRAFT });
    setFormError("");
    setReviewItem(null);
    setPublishCommandId("");
  }

  return (
    <div className="flow-page manual-news-page">
      <div className="flow-steps manual-flow-steps" aria-label="Flujo de publicación manual">
        <div className="active"><span>1</span><strong>Redactar y editar</strong></div>
        <div className={draft.image.trim() ? "active" : ""}><span>2</span><strong>Procesar imagen</strong></div>
        <div className={platforms.length ? "active" : ""}><span>3</span><strong>Publicar en destinos</strong></div>
      </div>

      <section className="manual-editor-grid">
        <Card title="Nueva noticia" eyebrow="Carga manual">
          <p className="card-intro">Completá la nota y revisá la vista previa. Al confirmar se enviará al mismo pipeline editorial que las demás noticias.</p>
          <form onSubmit={review} noValidate>
            <Field label="Título" hint={`${draft.title.length}/240 caracteres`}>
              <input value={draft.title} onChange={(event) => update("title", event.target.value)} maxLength={240} placeholder="Título de la noticia" autoFocus />
            </Field>
            <Field label="Noticia" hint={`${draft.body.length}/50.000 caracteres · separá los párrafos con una línea en blanco`}>
              <textarea className="manual-news-body" value={draft.body} onChange={(event) => update("body", event.target.value)} maxLength={50_000} rows={16} placeholder="Escribí el contenido completo de la noticia…" />
            </Field>
            <div className="grid two manual-meta-grid">
              <Field label="Categoría">
                <input value={draft.category} onChange={(event) => update("category", event.target.value)} maxLength={120} placeholder="Ej.: Política, Deportes, Salta" />
              </Field>
              <Field label="Fuente">
                <input value={draft.source} onChange={(event) => update("source", event.target.value)} maxLength={200} placeholder="Nombre de la fuente" />
              </Field>
            </div>
            <Field label="Imagen" hint="Usá una URL pública http/https. La PC local descargará, optimizará y comprimirá la imagen dentro del flujo habitual.">
              <input type="url" inputMode="url" value={draft.image} onChange={(event) => update("image", event.target.value)} maxLength={2048} placeholder="https://ejemplo.com/imagen.jpg" />
            </Field>
            {formError && <div className="inline-error" role="alert">{formError}</div>}
            <div className="actions manual-form-actions">
              <button type="button" onClick={reset}>Limpiar formulario</button>
              <button className="primary" type="submit" disabled={isActive(publishCommand)}>Revisar publicación</button>
            </div>
          </form>
        </Card>

        <Card title="Vista previa" eyebrow="Control editorial" className="manual-preview-card">
          <div className="manual-preview-media">
            {draft.image.trim()
              ? <img src={draft.image.trim()} alt="Vista previa de la noticia" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.style.display = "none"; }} />
              : <div className="media-fallback">HS</div>}
          </div>
          <div className="manual-preview-copy">
            <div className="article-meta"><span>{draft.category.trim() || "Sin categoría"}</span><time>{draft.source.trim() || "Sin fuente"}</time></div>
            <h3>{draft.title.trim() || "El título aparecerá aquí"}</h3>
            {preview.parrafos.length
              ? <div className="article-body">{preview.parrafos.slice(0, 8).map((paragraph: string, index: number) => <p key={index}>{paragraph}</p>)}</div>
              : <p className="manual-preview-empty">La vista previa del contenido aparecerá mientras escribís.</p>}
            {preview.parrafos.length > 8 && <small className="muted">La noticia continúa con {preview.parrafos.length - 8} párrafos más.</small>}
          </div>
        </Card>
      </section>

      <Card title="Destinos de publicación" eyebrow="WordPress y redes" className="publication-controls manual-destinations">
        <PlatformChooser selected={platforms} onChange={(next) => { setPlatforms(next); setFormError(""); }} />
        {platforms.includes("whatsapp") && (
          <WhatsAppSelector
            snapshots={snapshots}
            selectedIds={selectedGroupIds}
            selectedSet={selectedGroupSet}
            onSelectedIds={setSelectedGroupIds}
            onSelectedSet={setSelectedGroupSet}
            run={run}
          />
        )}
        <div className="publish-footer">
          <div><strong>1 noticia manual</strong><span>{platforms.length} destinos seleccionados</span></div>
          <button className="primary publish-button" disabled={Boolean(validateManualNewsDraft(draft)) || !platforms.length || isActive(publishCommand) || (platforms.includes("whatsapp") && !selectedGroups.length)} onClick={() => {
            const error = validateManualNewsDraft(draft);
            if (error) setFormError(error);
            else setReviewItem(buildManualNewsItem(draft));
          }}>Revisar y publicar</button>
        </div>
        <Progress command={publishCommand} />
        {publishCommand?.result && <><ResultSummary command={publishCommand} /><TechnicalDetails value={publishCommand.result} /></>}
      </Card>

      <ReviewModal
        open={Boolean(reviewItem)}
        title="Publicar noticia manual"
        items={reviewItem ? [reviewItem] : []}
        platforms={platforms}
        groups={selectedGroups}
        busy={isActive(publishCommand)}
        onClose={() => setReviewItem(null)}
        onConfirm={() => void publish()}
      />
    </div>
  );
}

export function News({ commands, snapshots, run }: ContentProps) {
  const snapshot = snapshots["news.current"];
  const wpPosts = normalizeItems(snapshots["wordpress.posts"]?.payload);
  const [draft, setDraft] = useState<ContentItem[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [source, setSource] = useState("all");
  const [search, setSearch] = useState("");
  const [onlyImages, setOnlyImages] = useState(false);
  const [view, setView] = useState<ViewMode>(() => readView("ops:news:view"));
  const [platforms, setPlatforms] = useState<string[]>(DEFAULT_PLATFORMS);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [selectedGroupSet, setSelectedGroupSet] = useState<ContentItem | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [publishCommandId, setPublishCommandId] = useState("");
  const [operationCommandId, setOperationCommandId] = useState("");
  const initialized = useRef("");

  useEffect(() => {
    const hash = String(snapshot?.contentHash ?? "");
    if (!hash || initialized.current === hash) return;
    initialized.current = hash;
    setDraft(normalizeItems(snapshot?.payload));
    setSelected([]);
  }, [snapshot?.contentHash, snapshot?.payload]);

  useEffect(() => {
    localStorage.setItem("ops:news:view", view);
  }, [view]);

  const sources = [...new Set(draft.map((item) => String(item.source || "")).filter(Boolean))];
  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("es");
    return draft.map((item, index) => ({ item, index })).filter(({ item }) => {
      if (source !== "all" && String(item.source) !== source) return false;
      if (onlyImages && !articleImage(item)) return false;
      return !term || `${articleTitle(item)} ${articleExcerpt(item)}`.toLocaleLowerCase("es").includes(term);
    });
  }, [draft, onlyImages, search, source]);
  const selectedItems = selected.map((index) => draft[index]).filter(Boolean);
  const groups = normalizeGroups(snapshots["whatsapp.groups"]?.payload);
  const selectedGroups = resolveSelectedGroups(groups, selectedGroupIds, selectedGroupSet);
  const publishCommand = commands.find((command) => command.id === publishCommandId);
  const operationCommand = commands.find((command) => command.id === operationCommandId);

  async function runNewsOperation(type: "news.load_wordpress" | "news.save" | "news.clear_cache" | "publish.clear", payload: Record<string, unknown>, notice: string) {
    const command = await run(type, payload, notice);
    if (command) setOperationCommandId(command.id);
  }

  async function handlePublish() {
    if (!selectedItems.length || !platforms.length) return;
    setReviewOpen(false);
    const command = await run("news.publish", {
      selectedIndices: [],
      directNewsItems: selectedItems,
      platforms,
      whatsappGroups: selectedGroups,
      whatsappGroupSet: selectedGroupSet,
      instagramEmojis: true,
    }, "Publicación de noticias encolada");
    if (command) setPublishCommandId(command.id);
  }

  return (
    <div className="flow-page">
      <Card title="Noticias preparadas" eyebrow="Redacción y publicación" actions={<ViewToggle value={view} onChange={setView} />}>
        <div className="news-actions">
          <button disabled={isActive(operationCommand)} onClick={() => void runNewsOperation("news.load_wordpress", { perPage: 100 }, "Importación de 100 noticias iniciada")}>Traer 100 de WordPress</button>
          <button disabled={isActive(operationCommand)} onClick={() => void runNewsOperation("news.save", { items: draft }, "Guardado de noticias iniciado")}>Guardar cambios</button>
          <button disabled={isActive(operationCommand)} className="danger-ghost" onClick={() => confirmed("¿Vaciar las noticias preparadas?") && void runNewsOperation("news.clear_cache", {}, "Vaciado de noticias iniciado")}>Vaciar noticias</button>
          <button disabled={isActive(operationCommand)} className="danger-ghost" onClick={() => confirmed("¿Limpiar el historial finalizado de publicaciones?") && void runNewsOperation("publish.clear", {}, "Limpieza de historial iniciada")}>Limpiar historial</button>
        </div>
        <Progress command={operationCommand} />
        {operationCommand && !isActive(operationCommand) && <ResultSummary command={operationCommand} />}
        <div className="filter-row">
          <Field label="Fuente">
            <select value={source} onChange={(event) => setSource(event.target.value)}>
              <option value="all">Todas</option>
              {sources.map((item) => <option value={item} key={item}>{sourceLabel(item)}</option>)}
            </select>
          </Field>
          <Field label="Buscar">
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Título o extracto…" />
          </Field>
          <label className="switch-row"><input type="checkbox" checked={onlyImages} onChange={(event) => setOnlyImages(event.target.checked)} />Solo con imagen</label>
        </div>
        {draft.length > 0 && <SelectionBar shown={visible.map(({ index }) => index)} selected={selected} label={`${draft.length} noticias · ${selected.length} seleccionadas`} onChange={setSelected} />}
        <ArticleList
          items={visible}
          selected={selected}
          onToggle={(index) => setSelected((current) => toggleIndex(current, index))}
          view={view}
          editable
          onChange={(index, item) => setDraft((current) => current.map((existing, currentIndex) => currentIndex === index ? item : existing))}
        />
      </Card>

      <Card title="Destinos de publicación" eyebrow="WordPress y redes" className="publication-controls">
        <PlatformChooser selected={platforms} onChange={setPlatforms} />
        {platforms.includes("whatsapp") && (
          <WhatsAppSelector
            snapshots={snapshots}
            selectedIds={selectedGroupIds}
            selectedSet={selectedGroupSet}
            onSelectedIds={setSelectedGroupIds}
            onSelectedSet={setSelectedGroupSet}
            run={run}
          />
        )}
        <div className="publish-footer">
          <div><strong>{selectedItems.length} noticias seleccionadas</strong><span>{platforms.length} destinos</span></div>
          <button className="primary publish-button" disabled={!selectedItems.length || !platforms.length || isActive(publishCommand) || (platforms.includes("whatsapp") && !selectedGroups.length)} onClick={() => setReviewOpen(true)}>Revisar y publicar</button>
        </div>
        <Progress command={publishCommand} />
        {publishCommand?.result && <><ResultSummary command={publishCommand} /><TechnicalDetails value={publishCommand.result} /></>}
      </Card>

      <WordPressArchive posts={wpPosts} platforms={platforms.filter((platform) => platform !== "web")} groups={selectedGroups} groupSet={selectedGroupSet} run={run} />

      <ReviewModal
        open={reviewOpen}
        title="Publicar noticias"
        items={selectedItems}
        platforms={platforms}
        groups={selectedGroups}
        busy={isActive(publishCommand)}
        onClose={() => setReviewOpen(false)}
        onConfirm={() => void handlePublish()}
      />
    </div>
  );
}

export function WhatsAppSelector({
  snapshots,
  selectedIds,
  selectedSet,
  onSelectedIds,
  onSelectedSet,
  run,
}: {
  snapshots: SnapshotMap;
  selectedIds: string[];
  selectedSet: ContentItem | null;
  onSelectedIds(next: string[]): void;
  onSelectedSet(next: ContentItem | null): void;
  run: RunCommand;
}) {
  const groups = normalizeGroups(snapshots["whatsapp.groups"]?.payload);
  const sets = normalizeSets(snapshots["whatsapp.group_sets"]?.payload);
  const [filter, setFilter] = useState("");
  const [setName, setSetName] = useState("");
  const defaultApplied = useRef(false);
  const visible = groups.filter((group) => String(group.nombre ?? "").toLocaleLowerCase("es").includes(filter.toLocaleLowerCase("es")));

  useEffect(() => {
    if (defaultApplied.current || !sets.length) return;
    if (selectedSet || selectedIds.length) {
      defaultApplied.current = true;
      return;
    }
    const defaultSet = sets.find(isDefaultGroupSet);
    if (!defaultSet) return;
    defaultApplied.current = true;
    onSelectedSet(defaultSet);
    onSelectedIds(normalizeGroups(defaultSet).map((group) => String(group.id)));
  }, [onSelectedIds, onSelectedSet, selectedIds.length, selectedSet, sets]);

  function chooseSet(id: string) {
    const set = sets.find((item) => String(item.id) === id) ?? null;
    onSelectedSet(set);
    if (set) onSelectedIds(normalizeGroups(set).map((group) => String(group.id)));
  }

  async function saveSet() {
    const chosen = groups.filter((group) => selectedIds.includes(String(group.id)));
    if (!setName.trim() || !chosen.length) return;
    await run("whatsapp.group_set.save", { nombre: setName.trim(), grupos: chosen }, "Conjunto de WhatsApp encolado");
    setSetName("");
  }

  return (
    <section className="whatsapp-box">
      <div className="whatsapp-head">
        <div><strong>Grupos de WhatsApp</strong><span>{selectedIds.length} seleccionados de {groups.length}</span></div>
        <button onClick={() => void run("whatsapp.groups.extract", {}, "Actualización de grupos encolada")}>Actualizar desde WhatsApp</button>
      </div>
      <div className="whatsapp-controls">
        <Field label="Conjunto guardado">
          <select value={selectedSet ? String(selectedSet.id) : ""} onChange={(event) => chooseSet(event.target.value)}>
            <option value="">Selección manual</option>
            {sets.map((set) => <option value={String(set.id)} key={String(set.id)}>{String(set.nombre)}</option>)}
          </select>
        </Field>
        <Field label="Buscar grupo"><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Nombre del grupo…" /></Field>
      </div>
      <div className="group-list">
        {visible.map((group) => {
          const id = String(group.id);
          return <label key={id} className={selectedIds.includes(id) ? "selected" : ""}><input type="checkbox" checked={selectedIds.includes(id)} onChange={() => { onSelectedSet(null); onSelectedIds(selectedIds.includes(id) ? selectedIds.filter((item) => item !== id) : [...selectedIds, id]); }} /><span>{String(group.nombre)}</span></label>;
        })}
        {!visible.length && <Empty text="No hay grupos disponibles" detail="Usá “Actualizar desde WhatsApp” para sincronizarlos." />}
      </div>
      <div className="save-set"><input value={setName} onChange={(event) => setSetName(event.target.value)} placeholder="Nombre para guardar esta selección" /><button disabled={!setName.trim() || !selectedIds.length} onClick={() => void saveSet()}>Guardar conjunto</button></div>
    </section>
  );
}

function WordPressArchive({ posts, platforms, groups, groupSet, run }: { posts: ContentItem[]; platforms: string[]; groups: ContentItem[]; groupSet: ContentItem | null; run: RunCommand }) {
  const [search, setSearch] = useState("");
  const filtered = posts.filter((post) => articleTitle(post).toLocaleLowerCase("es").includes(search.toLocaleLowerCase("es")));
  return (
    <Card title="Publicados en WordPress" eyebrow="Archivo reciente" actions={<span className="small-count">{posts.length} posts</span>}>
      <div className="filter-row"><Field label="Buscar en WordPress"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar post…" /></Field></div>
      <div className="wp-list">
        {filtered.map((post, index) => (
          <article key={String(post.id ?? articleUrl(post) ?? index)}>
            <div>{articleImage(post) && <img src={articleImage(post)} alt="" loading="lazy" />}<span><strong>{articleTitle(post)}</strong><small>{shortDate(post.fecha ?? post.date)}</small></span></div>
            <button disabled={!platforms.length || (platforms.includes("whatsapp") && !groups.length)} onClick={() => void run("wordpress.share", { post, platforms, whatsappGroups: groups, whatsappGroupSet: groupSet, instagramEmojis: true }, "Distribución del post encolada")}>Compartir en redes</button>
          </article>
        ))}
        {!filtered.length && <Empty text="No hay posts de WordPress sincronizados" />}
      </div>
    </Card>
  );
}

function SelectionBar({ shown, selected, label, onChange }: { shown: number[]; selected: number[]; label: string; onChange(next: number[]): void }) {
  const allShown = shown.length > 0 && shown.every((index) => selected.includes(index));
  return (
    <div className="selection-bar">
      <strong>{label}</strong>
      <div className="actions">
        <button onClick={() => onChange(allShown ? selected.filter((index) => !shown.includes(index)) : [...new Set([...selected, ...shown])])}>{allShown ? "Quitar visibles" : "Seleccionar visibles"}</button>
        {selected.length > 0 && <button onClick={() => onChange([])}>Limpiar selección</button>}
      </div>
    </div>
  );
}

function FlowSteps({ steps }: { steps: Array<{ label: string; complete?: boolean; active?: boolean }> }) {
  return <div className="flow-steps">{steps.map((step, index) => <div key={step.label} className={step.complete ? "complete" : step.active ? "active" : ""}><span>{step.complete ? "✓" : index + 1}</span><strong>{step.label}</strong></div>)}</div>;
}

function ViewToggle({ value, onChange }: { value: ViewMode; onChange(next: ViewMode): void }) {
  return <div className="view-toggle"><button className={value === "card" ? "active" : ""} onClick={() => onChange("card")}>Tarjetas</button><button className={value === "compact" ? "active" : ""} onClick={() => onChange("compact")}>Compacta</button></div>;
}

function normalizeItems(payload: unknown): ContentItem[] {
  if (Array.isArray(payload)) return payload.filter(isObject);
  if (!isObject(payload)) return [];
  for (const key of ["items", "articles", "posts", "noticias"]) if (Array.isArray(payload[key])) return payload[key].filter(isObject);
  return [];
}

export function normalizeGroups(payload: unknown): ContentItem[] {
  if (Array.isArray(payload)) return payload.filter(isObject);
  if (!isObject(payload)) return [];
  for (const key of ["grupos", "groups", "items"]) if (Array.isArray(payload[key])) return payload[key].filter(isObject);
  return [];
}

function normalizeSets(payload: unknown): ContentItem[] {
  if (Array.isArray(payload)) return payload.filter(isObject);
  if (!isObject(payload)) return [];
  for (const key of ["sets", "items", "group_sets"]) if (Array.isArray(payload[key])) return payload[key].filter(isObject);
  return [];
}

function isDefaultGroupSet(set: ContentItem) {
  if (set.default === true || set.predeterminado === true) return true;
  return /(^|[-_\s])(predeterminado|default)([-_\s]|$)/i.test(`${String(set.id ?? "")} ${String(set.nombre ?? "")}`);
}

function resolveSelectedGroups(groups: ContentItem[], selectedIds: string[], selectedSet: ContentItem | null) {
  const setGroups = normalizeGroups(selectedSet);
  return setGroups.length ? setGroups : groups.filter((group) => selectedIds.includes(String(group.id)));
}
function readView(key: string): ViewMode {
  return localStorage.getItem(key) === "compact" ? "compact" : "card";
}

function confirmed(message: string) {
  return window.confirm(message);
}

function isObject(value: unknown): value is ContentItem {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
