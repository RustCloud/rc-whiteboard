# rc-whiteboard — «Доска» для RustCloud

Плагин RustCloud `rc-whiteboard` (в панели — «Доска»): доски [Excalidraw](https://github.com/excalidraw/excalidraw)
из файлов пользователя открываются и редактируются в любой папке, как документы в
[«Офисе»](https://github.com/RustCloud/rc-office). Доска — обычный файл пользователя: версии, квота, журнал,
корзина остаются за ядром.

- **Открыть** — в «Файлах» пункт «Открыть в Доске» в меню файла `.excalidraw` или `.whiteboard`
  (Nextcloud Whiteboard). Доска открывается на всё окно; «Закрыть» на доске или «×» панели возвращают к
  файлам.
- **Создать** — «Создать» → «Доска» в списке файлов: `Доска.excalidraw` появляется в открытой папке и сразу
  открывается.
- **Сохранение** — само: через 2 секунды после изменения, не чаще раза в 5 секунд, и при закрытии. Сохранения
  ядро складывает в [версии](https://github.com/RustCloud/server) файла (частые сохранения одного человека —
  в одну). В углу доски — «Сохранено» / «Сохранение…» / «Не сохранено».
- **Один редактор** — пока доска открыта, файл заблокирован: панель и другие приложения его не меняют.
  Открыли ту же доску в другой вкладке — правка переходит туда, первая вкладка становится «только для чтения»
  (и предлагает скачать несохранённое). Закрыли — блокировка снимается; вкладка пропала — истекает сама
  через 30 минут.
- **Конфликт** — если файл всё же изменился мимо доски (блокировка истекла, владелец её снял), доска
  спросит: перезаписать своей версией, загрузить их или скачать свою копию. Чужие правки молча не
  затираются.
- **Только чтение** — файл без права записи и файл, который держит другое приложение, открываются для
  просмотра.
- **Картинки любого размера** — доска с картинками не проходит через память плагина: ядро отдаёт файл и
  сохраняет его потоком (`x-rustcloud-send`, `write-request-body`, `large_bodies`).
- **Без интернета** — шрифты и всё остальное приходят с сервиса доски, внешних адресов у доски нет
  (CSP `default-src 'self'`).
- **Библиотека фигур** — своя у каждого пользователя в этом браузере (`localStorage` на адресе облака);
  импорт `.excalidrawlib` — из файла.

## Формат файлов

`.excalidraw` (Excalidraw) и `.whiteboard` (Nextcloud Whiteboard) — один и тот же JSON сцены. Доска читает
оба и пишет объединение: `type`, `version`, `elements`, `appState`, `files` (картинки внутри файла) — как
Excalidraw, плюс `scrollToContent` и все ключи, которых она не знает (`libraryItems`, `libraryRef`
Nextcloud), — как были. Поэтому файл, сохранённый здесь, открывают Nextcloud, excalidraw.com и VS Code, и
наоборот. Пустой файл (так Nextcloud создаёт новые доски) — новая доска; пока на ней ничего не нарисовали,
он остаётся пустым. Подробности — [frontend/src/format.js](frontend/src/format.js).

Новые доски — `.excalidraw`: родной формат Excalidraw, Nextcloud открывает его тоже (оба расширения у него —
`application/vnd.excalidraw+json`).

## Установка

1. Запустите сервис доски рядом с облаком — в том же `compose.yml`, без порта наружу:

   ```yaml
   services:
     whiteboard:
       image: ghcr.io/rustcloud/whiteboard:latest
       restart: unless-stopped
   ```

   Образ ~40 МБ (бинарник на Rust и собранная доска), без состояния и настроек, памяти — единицы МБ.
   Браузеры ходят к нему только через адрес облака: ядро пересылает `/whiteboard` в контейнер
   (`[[proxy]]`, API 0.2.15), только пользователю с открытой в «Доске» доской.

2. Установите `rc-whiteboard.zip` в «Администрирование → Плагины» (архив — в
   [релизах](https://github.com/RustCloud/rc-whiteboard/releases) или артефакт сборки Actions) и включите
   плагин. Он просит доступ к открытому файлу, адрес сервиса в `network` и **сервис через адрес облака**:
   доска работает на адресе облака, ставьте только этот сервис.

3. Настройка плагина там же — одна:

   | Настройка     | Что это                                                                       |
   |---------------|-------------------------------------------------------------------------------|
   | `service_url` | внутренний адрес сервиса доски, как до него достаёт сервер облака: `http://whiteboard:8080` |

4. Вкладка «Состояние» в окне плагина показывает, отвечает ли сервис и совпадает ли его версия с
   плагином. Пункта в боковой панели у «Доски» нет.

Нужен RustCloud с API плагинов 0.2.17. Известные ограничения ядра (открытие по расширению, общие файлы) —
[docs/core-tasks.md](docs/core-tasks.md).

## Как устроена

| Где                         | Что                                                                          |
|-----------------------------|------------------------------------------------------------------------------|
| [src/](src)                 | плагин (WASM): страница-оболочка, блокировка и токен (`/session`), файл доски для токена (`/board`, `/lock`), «Состояние» |
| [ui/](ui)                   | страница плагина: просит `/session` и показывает доску через `rustcloud.openFrame` |
| [frontend/](frontend)       | доска: React + `@excalidraw/excalidraw`, формат файлов, автосохранение      |
| [service/](service)         | сервис доски (Rust, axum): отдаёт собранную доску под `/whiteboard/`       |
| [Dockerfile](Dockerfile)    | образ сервиса: доска и сервис в одном статическом бинарнике, `scratch`     |
| [e2e/](e2e)                 | проверка в Chromium против настоящего облака                                |

```text
«Открыть в Доске» → панель: доступ session к файлу, #/app/rc-whiteboard/edit?file=<id>
страница плагина ── POST /session ──▶ плагин: блокировка (своя на каждое открытие), токен на файл (10 ч)
                 ◀── { token, lock, write, read_only } ──
rustcloud.openFrame(<облако>/whiteboard/#file=…&token=…&lock=…)   (фрагмент не уходит на сервер)
доска (сервис через [[proxy]], адрес облака):
  GET  /app/rc-whiteboard/board/<id>              Bearer <token>   → файл потоком, ETag
  PUT  /app/rc-whiteboard/board/<id>?lock=…       If-Match         → write-request-body, новый etag
  POST /app/rc-whiteboard/lock/<id>?action=refresh|unlock          → блокировка 30 мин, раз в 10 мин
  postMessage → страница плагина: новый токен, «закрыть»
```

- Маршруты `/board`, `/lock` — только с токеном именно этого файла; `/session`, `/status` — только
  пользователь, не токен. Сохранение — только под своей блокировкой и с `If-Match`.
- Сервис ничего не хранит и ничего не знает о пользователях: всё, что меняет файлы, — плагин по токену.
- Совместная правка в реальном времени (WebSocket-комнаты в сервисе) — следующий шаг, см. [PLAN.md](PLAN.md).

## Сборка

```sh
# плагин
rustup target add wasm32-wasip2
cargo test && cargo build --release --target wasm32-wasip2
mkdir -p dist/rc-whiteboard && cp manifest.toml dist/rc-whiteboard/
cp target/wasm32-wasip2/release/rc_whiteboard.wasm dist/rc-whiteboard/app.wasm
(cd dist && zip -r rc-whiteboard.zip rc-whiteboard)

# сервис с доской (Node 22 и Rust внутри сборки)
docker build -t rc-whiteboard-service:dev .

# e2e: облако, сервис и Chromium в Docker
e2e/test-zip.sh dist/rc-whiteboard dist/rc-whiteboard-e2e.zip && e2e/run.sh dist/rc-whiteboard-e2e.zip
```

Без Docker: `(cd frontend && npm ci && npm test && npm run build)`, затем `(cd service && cargo run)` —
сервис встраивает `frontend/dist` при сборке.

[.github/workflows/build.yml](.github/workflows/build.yml) делает всё это на каждый пуш (версии, `fmt`,
`clippy`, тесты плагина, сервиса и доски, e2e) и выкладывает артефакт `rc-whiteboard-<версия>`. Пуш в
`main` публикует образ `ghcr.io/rustcloud/whiteboard:main`; с новой версией в `manifest.toml` — ещё релиз
`v<версия>` с `rc-whiteboard.zip` и образ `:<версия>` и `:latest`. Версия одна в `manifest.toml`,
`Cargo.toml`, `service/Cargo.toml` и `frontend/package.json`.

`wit/app.wit` — копия `crates/plugin-api/wit/app.wit` ядра версии из `manifest.toml` (`api`).

## Лицензия

MIT или Apache-2.0, на выбор. Excalidraw — MIT.
