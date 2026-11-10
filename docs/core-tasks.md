# Задачи для ядра (RustCloud)

Что мешает «Доске» и что нужно поменять в ядре — сам плагин это обойти не может. Проверено на
`ghcr.io/rustcloud/server:latest` (коммит `dadc046`, API 0.2.17), 2026-11-10.

## 1. Панель открывает файл в плагине только по mime, без `extensions` (ошибка)

`[[open_with]] extensions` (с 0.2.17) учитывает список файлов ([web/src/lib/apps.ts](../../rustcloud/web/src/lib/apps.ts),
`openersFor`: `mimeMatches(...) || extensionMatches(...)`), а страница плагина, которая этот файл
открывает, — нет: [AppFrame.svelte](../../rustcloud/web/src/components/AppFrame.svelte), `openFile`:

```ts
const opener = entries.find((open) => '/' + path === open.page && mimeMatches(open.mime, node.mime_type));
```

Итог: в меню `.excalidraw` есть «Открыть в Доске», а после выбора панель пишет «приложение не может
открыть файл» (`t.appCannotOpen`): у `.excalidraw` и `.whiteboard` тип `application/octet-stream`.
То же у текстового редактора с `.env`, `Dockerfile`, `.ts` (`video/mp2t`).

Исправление — то же условие, что в `apps.ts`:

```ts
const opener = entries.find(
  (open) => '/' + path === open.page &&
    (mimeMatches(open.mime, node.mime_type) || extensionMatches(open.extensions, node.name)),
);
```

и тест в `apps.test.ts`/e2e: файл с подходящим расширением и чужим типом открывается по прямой ссылке.

Пока не исправлено, e2e плагина ставит его с `application/octet-stream` в `mime`
([e2e/test-zip.sh](../e2e/test-zip.sh)). В настоящий манифест это не попадает: «Открыть в Доске» было бы у
любого двоичного файла.

## 2. Типы `.excalidraw` и `.whiteboard` (по желанию)

`mime_guess` не знает этих расширений (`application/octet-stream`). Nextcloud сопоставляет оба с
`application/vnd.excalidraw+json` (`resources/config/mimetypemapping.dist.json`). Если ядро сделает так же
(например, своей таблицей перед `mime_guess` в [files/src/service.rs](../../rustcloud/crates/files/src/service.rs),
`guess_mime`), то:

- пункт 1 перестанет мешать и без исправления панели;
- у досок будет понятный тип в списке файлов и в API, а не «двоичный файл».

Плагин уже указывает `mime = ["application/vnd.excalidraw+json"]` — ничего менять не придётся.

## 3. Получатель общего файла не может открыть его в плагине (ограничение)

[sharing.md](../../rustcloud/docs/api/sharing.md): «доступ приложений … остаются за владельцем (`404`
для получателя)». Пользователь, которому дали доску (даже с правом изменять), открывает её в «Доске» —
панель отвечает «File or folder not found»: `POST /api/v1/grants` на чужой узел — `404`. То же у «Офиса».

Чтобы доски (и документы) работали с общими файлами, получателю нужен доступ `session` к узлу, который
ему открыли, в пределах его прав (на запись — только с `write`). Квота, версии и журнал — владельца,
как при обычной записи получателем. Блокировка у «Доски» уже рассчитана на это: второй пользователь
видит «доску редактирует другой пользователь» и открывает её только для чтения.

## 4. Нестрашное, на заметку

- **Лимит прокси:** `[plugins] proxy_requests_per_user = 16`. Доска при открытии загружает около 60
  файлов (скрипты, шрифты) — в e2e всё прошло без `429`, браузер сам ограничивает параллельность. Если
  на медленном диске появятся `429` — поднять лимит.
