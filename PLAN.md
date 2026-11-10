# rc-whiteboard — план реализации

Плагин RustCloud «Доска» (`rc-whiteboard`): доски [Excalidraw](https://github.com/excalidraw/excalidraw)
из файлов пользователя (`.excalidraw`, `.whiteboard` от Nextcloud Whiteboard) открываются и
редактируются в любой папке, как документы в [rc-office](../rc-office). Доска — обычный файл
пользователя: версии, квота, журнал, корзина и общий доступ остаются за ядром.

Решения (2026-11-10):

- Excalidraw работает в браузере. Его показывает **свой сервис** (контейнер на Rust) через
  `[[proxy]]` ядра, на адресе облака. Песочница страницы плагина не подходит: у неё непрозрачный
  origin, а значит, нет `localStorage`/IndexedDB, шрифтов и воркеров без CORS (ядро вырезает
  `Access-Control-*`) и буфера обмена.
- **v1 — один редактор:** файл держит блокировка ядра, остальные открывают только для чтения.
  Совместная правка в реальном времени — v2, тем же сервисом (WebSocket через прокси).
- Сервис — **Rust** (axum). В v1 он только отдаёт собранный фронт, файл фронт читает и сохраняет
  сам через маршруты плагина по токену.
- `.whiteboard` от Nextcloud **поддерживается**: открывается и сохраняется в своём формате.
- `rustcloud` (ядро) не меняем. Если ядру чего-то не хватит — задача в `docs/`, как
  `rc-office/docs/core-service-proxy.md`.
- Новые доски — `.excalidraw` (Nextcloud открывает и их).

## Состояние (2026-11-10)

v1 сделана — шаги 1–6 ниже, e2e проходит против `ghcr.io/rustcloud/server:latest` (`dadc046`):
открыть, нарисовать, автосохранение, текст со шрифтом с сервиса, блокировка от панели, вторая вкладка
перехватывает правку, закрытие снимает блокировку, `.whiteboard` с ключами Nextcloud, пустой файл,
ни одного запроса за пределы облака.

Что по ходу вышло иначе, чем в плане ниже:

- **Блокировка — своя на каждое открытие.** Новое открытие тем же пользователем (вторая вкладка,
  перезагрузка, новый токен) снимает прежнюю и берёт новую: прежняя вкладка при следующем сохранении
  получает `409 locked` (`by: "self"`) и становится только для чтения.
- **Чужой пользователь до доски не доходит:** получатель общего файла не может дать плагину доступ
  к нему (ядро, [docs/core-tasks.md](docs/core-tasks.md), п. 3). Ветка «доску правит другой
  пользователь» в коде есть, но сработает, когда ядро это разрешит.
- **Открытие по расширению сломано в панели ядра** (п. 1 там же): пока не исправят, `.excalidraw`
  в списке файлов открывается с ошибкой. e2e обходит это своим манифестом.
- **Шрифты:** Excalidraw добавляет к каждому шрифту запасной адрес esm.sh — сборка заменяет его путём
  сервиса (`vite.config.js`, `noFontCdn`), иначе Chrome пробует CDN для ~230 начертаний.
- Маршрут `GET /board/<id>/info` (etag сейчас) — для «перезаписать своей версией» при конфликте.
- «Сохранить копию» в облако плагин не может (доступ только к открытому файлу): при конфликте и
  потере блокировки — «Скачать копию».

Дальше: исправления ядра (docs/core-tasks.md), затем v2 — совместная правка.

## Как это работает (v1)

```text
Браузер (панель)                     RustCloud: ядро + плагин rc-whiteboard          Сервис-доска
────────────────                     ────────────────────────────────────           ────────────
«Открыть в Доске» ─────────────────▶ доступ session к файлу,
                                     #/app/rc-whiteboard/edit?file=<id>
страница плагина (песочница):
  rustcloud.fetch POST /session ───▶ плагин: files.get (имя, права, etag)
                                     lock(file, <новый lock-id>, 30 мин) → Held | Taken
                                     tokens.issue(file, write = есть запись и Held, 10 ч)
              ◀── { token, lock_id, write, locked_by?, name } ──
  rustcloud.openFrame({ method: 'get',
    url: origin + '/whiteboard/#file=<id>&token=…&lock=…&write=1&theme=dark&lang=ru' })
                                                                                    
iframe /whiteboard/ (origin облака) ── HTTP через [[proxy]] ────────────────────────▶ статика фронта
  фронт Excalidraw:
    GET  /app/rc-whiteboard/board/<id>        Bearer <token> ─▶ плагин: x-rustcloud-send file:<id>
    PUT  /app/rc-whiteboard/board/<id>        If-Match: <etag> ─▶ write-request-body(id, etag)
    POST /app/rc-whiteboard/lock/<id>         (продление раз в 10 мин, снятие при закрытии)
  postMessage ⇄ панель ⇄ страница плагина: close, modified, token-expired → новый /session
```

- Токен — во **фрагменте** URL (`#…`): он не уходит на сервер, в логи прокси и в `Referer`.
  `openFrame` с `method: 'get'`: статике форма `POST` не нужна.
- Маршруты `/board`, `/lock` принимают **только токен** этого файла (`tokens.current()`), маршрут
  `/session` — только пользователя (не токен), как в rc-office.
- Чтение — ответом файлом (`x-rustcloud-send`), запись — `write-request-body` с `large_bodies = true`:
  картинки внутри доски (dataURL) не упираются в 16 МБ данных плагина.

## Манифест (черновик)

```toml
id = "rc-whiteboard"
version = "0.1.0"
api = "^0.2.17"          # extensions у [[open_with]]
large_bodies = true
status = "/status"

[name]
en = "Whiteboard"
ru = "Доска"

[permissions]
files = "opened"
files_write = true
network = ["{service_url}"]          # только проверка на вкладке «Состояние»

[[proxy]]
target = "{service_url}"
paths = ["/whiteboard"]

[[server_settings]]
key = "service_url"
kind = "text"
label = { en = "Whiteboard service address (inside)", ru = "Адрес сервиса доски (внутренний)" }
hint = { en = "As this server reaches it, e.g. http://whiteboard:8080",
         ru = "Как до него достаёт сервер облака, например http://whiteboard:8080" }

[[open_with]]
mime = ["application/vnd.excalidraw+json"]
extensions = ["excalidraw", "whiteboard"]   # mime_guess их не знает: octet-stream
page = "/edit"
write = true
layout = "full"
label = { en = "Open in Whiteboard", ru = "Открыть в Доске" }

[[new_files]]
extension = "excalidraw"
label = { en = "Whiteboard", ru = "Доска" }
template = "/templates/empty.excalidraw"   # минимальная сцена: пустой файл другие программы не откроют
```

Новые доски — `.excalidraw` (решено 2026-11-10): родной формат Excalidraw, его знают сторонние
программы, и Nextcloud его тоже открывает — в `mimetypemapping.dist.json` ядра Nextcloud и
`excalidraw`, и `whiteboard` → `application/vnd.excalidraw+json`, а Whiteboard регистрирует свой
просмотрщик по этому mime, не по расширению. `.whiteboard` из Nextcloud открывается и сохраняется тем же
форматом, без переименования.

## Формат файла

Фронт приводит файл к сцене Excalidraw (`restore` из `@excalidraw/excalidraw`) и пишет обратно:

| Вход                                   | Как читаем                                                |
|----------------------------------------|-----------------------------------------------------------|
| пустой файл / только пробелы           | пустая доска (так Nextcloud создаёт новые `.whiteboard`)  |
| `.excalidraw` (`type`, `version`, `source`, `elements`, `appState`, `files`) | как есть |
| `.whiteboard` (без `type`/`version`, `scrollToContent`, `libraryItems`, `libraryRef`, `customData.creator*` у элементов) | как есть, лишние ключи помним |
| `{"data": {...}}` (обёртка Nextcloud)  | разворачиваем                                             |
| не JSON / не сцена                     | ошибка «не доска», файл не трогаем, только чтение         |

Запись — один формат для обоих расширений, объединение того, что ждут Excalidraw и Nextcloud:

- `type: "excalidraw"`, `version: 2`, `source`, `elements`, `appState` (как `serializeAsJSON`
  Excalidraw: без `collaborators`, `selectedElementIds` и прочего состояния окна), `files`;
- плюс `scrollToContent: true` и **все неизвестные ключи, прочитанные из файла** (`libraryItems`,
  `libraryRef`…). `customData` элементов Excalidraw сохраняет сам. Новым элементам
  `customData.creator` не придумываем — Nextcloud добавит при своей записи (его `creatorProof` —
  HMAC с ключом Nextcloud, подделать его нельзя и не нужно).
- Nextcloud такой файл читает (`normalizeStoredData` берёт `type`, `version`, `elements`, `files`,
  `appState`, `scrollToContent`, `libraryItems`, `libraryRef`, `source`); excalidraw.com, Obsidian и
  VS Code-расширение — тоже (`.excalidraw` — напрямую; `.whiteboard` — по содержимому
  `type: "excalidraw"`, в диалоге открытия придётся выбрать «все файлы»).
- Неиспользуемые картинки из `files` убираем, как Excalidraw при экспорте.
- Пустую доску в пустой файл не записываем (не плодим версии при открытии и закрытии).

## Сохранение и конфликты

- Автосохранение: через 2 с после последнего изменения (`onChange`, сравнение по
  `version`/`versionNonce` элементов, чтобы не сохранять движение камеры), не чаще раза в 5 с;
  плюс при закрытии (кнопка «Закрыть» фронта → сохранить → `postMessage` → `rustcloud.close()`).
  Ядро схлопывает версии одного человека чаще 5 минут.
- `If-Match` по etag последнего чтения или записи. `409` — файл изменили мимо доски (блокировка
  истекла, владелец снял): диалог «Перезагрузить» / «Перезаписать» / «Сохранить копию».
- Блокировка 30 минут, продление раз в 10 минут, пока открыта доска; при закрытии — `unlock`.
  Панель закрыли «×» без сохранения — последние ≤2 с правок могут потеряться (попытка
  `fetch(…, { keepalive: true })` на `pagehide`, тело до 64 КБ).
- Чужая блокировка (`Taken`): открываем `viewModeEnabled`, с плашкой «Сейчас редактирует <имя>
  (<приложение>)». Без права записи — так же, с «Только чтение».
- Токен истёк (`401`): фронт просит у страницы плагина новый (`postMessage` → `/session`).

## Фронт (Excalidraw)

- Vite + React + `@excalidraw/excalidraw` 0.18.x, собирается в статику, которую сервис встраивает
  в бинарник.
- **Без интернета:** `window.EXCALIDRAW_ASSET_PATH = "/whiteboard/"`, шрифты в сборке. Выключить
  то, что ходит наружу: ссылки Excalidraw+, «Просмотреть библиотеки» (libraries.excalidraw.com —
  возврат через URL сайта не сработает), AI-функции. Mermaid → Excalidraw — внутри бандла, работает.
- Тема (`light`/`dark`) и язык (`en`/`ru`) — из фрагмента URL (страница берёт их из
  `rustcloud.context`); акцентный цвет панели — по желанию, CSS-переменными.
- Экспорт PNG/SVG/JSON — встроенный Excalidraw, скачивание в браузере.
- Своя кнопка «Закрыть» и имя файла в `renderTopRightUI`.

## Сервис (Rust)

- `axum`, статика фронта встроена (`rust-embed` или `include_dir`), отдаётся под `/whiteboard/`
  с правильными `Content-Type`, `Cache-Control: immutable` для хэшированных файлов и `no-cache` для
  `index.html`.
- `GET /whiteboard/version` — `{ version }` для вкладки «Состояние» плагина.
- Без состояния, без конфигурации кроме `LISTEN` (по умолчанию `0.0.0.0:8080`). Образ — `scratch`
  или `distroless` с musl-бинарником, единицы мегабайт.
- v2: `GET /whiteboard/ws` — комнаты по файлу, сервис сам загружает и сохраняет по токенам
  участников (те же маршруты `/board` плагина), слияние элементов по `version`/`versionNonce`.

## Плагин (WASM)

Маленький, по образцу rc-office (`backend.rs` / `host.rs` для тестов без ядра):

| Маршрут              | Кто           | Что                                                          |
|----------------------|---------------|--------------------------------------------------------------|
| `GET /edit`          | пользователь  | страница-оболочка (`ui/edit.html`, `edit.js`, `i18n.js`)     |
| `POST /session`      | пользователь  | права, блокировка, токен; ответ для `openFrame`              |
| `GET /board/<id>`    | токен         | файл потоком (`x-rustcloud-send`), `ETag`                    |
| `PUT /board/<id>`    | токен на запись | `write-request-body(id, if-match)`, проверка нашей блокировки; новый etag |
| `POST /lock/<id>`    | токен         | `{ action: "refresh" \| "unlock", lock_id }`                 |
| `GET /templates/empty.excalidraw` | панель | шаблон для «Создать»                            |
| `GET /status`        | администратор | сервис отвечает (`/whiteboard/version`), версия, совпадает ли с плагином |

## Порядок работ

1. **Каркас репозитория:** `manifest.toml`, плагин (`Cargo.toml`, `src/`, `wit/app.wit` — копия ядра
   0.2.17), `frontend/` (Vite), `service/` (axum), `.github/workflows/`, README.
2. **Плагин:** `/session`, `/board` GET/PUT, `/lock`, `/status`; тесты на поддельном хосте.
3. **Фронт:** загрузка и нормализация обоих форматов, автосохранение с `If-Match`, режим чтения,
   конфликт, закрытие, тема и язык, оффлайн-шрифты; юнит-тесты формата (vitest) на образцах
   `.excalidraw` и `.whiteboard`.
4. **Сервис:** статика и `/version`; Dockerfile; `compose`-пример.
5. **Сборка и проверка на buildserver:** ядро + сервис + плагин, смоук в Chromium (открыть, нарисовать,
   сохранить, второй пользователь — только чтение, конфликт, большая картинка > 16 МБ).
6. **CI:** архив плагина `rc-whiteboard.zip` и образ сервиса; релиз по версии в `manifest.toml`.

Позже:

- v2 — совместная правка (WebSocket-комнаты в сервисе, heartbeat: прокси рвёт WebSocket после 5 минут
  тишины);
- личная библиотека фигур в AppData (`library.excalidrawlib`), импорт `.excalidrawlib`;
- превью доски в списке файлов (SVG/PNG);
- «Сохранить как PNG/SVG в облако»;
- просмотр по публичной ссылке (прокси пускает только вошедших: нужен другой путь, например
  статичный SVG от плагина).

## Открытые вопросы

- Решено: репозиторий `github.com/RustCloud/rc-whiteboard`, CI `.github/workflows`, образ
  `ghcr.io/rustcloud/whiteboard`, id `rc-whiteboard`, путь прокси `/whiteboard`.
- Проверено e2e: `x-rustcloud-send` и `write-request-body` с токеном из браузера работают, ETag
  ответа — etag файла.
