// Texts of the page, by the panel's language (context.locale).
const TEXTS = {
  en: {
    opening: (name) => `Opening ${name}…`,
    starting: 'Starting the board…',
    retry: 'Try again',
    close: 'Close',
    readOnly: 'Open read-only',
    errors: {
      'no-file': 'No board to open. Open one from Files: its menu → “Open in Whiteboard”.',
      'no-origin': 'This version of the cloud’s panel can’t show the board. Update RustCloud.',
      'no-service-url':
        'The Whiteboard is not set up: the administrator enters the address of the whiteboard service in Administration → Plugins → Whiteboard.',
      unsupported: 'This is not a whiteboard file (.excalidraw, .whiteboard).',
      'not-found': 'The board is not open for the Whiteboard any more. Open it again from Files.',
      retry: 'The file’s permissions changed. Try again.',
      'frame-failed': 'The panel refused to show the board.',
      'frame-timeout':
        'The board did not load. The whiteboard service must answer the cloud’s server at its address (Administration → Plugins → Whiteboard → Status).',
      'load-failed': 'The board could not be opened.',
      'not-a-board': 'The file is not a board Excalidraw can read.',
      failed: 'Something went wrong.',
    },
    lockedByUser:
      'Someone else is editing this board now. It can be opened read-only until they close it.',
    lockedByApp: (app) =>
      `The board is being edited in the app “${app}”. It can be opened read-only until that app is done with it.`,
  },
  ru: {
    opening: (name) => `Открываем ${name}…`,
    starting: 'Запускаем доску…',
    retry: 'Повторить',
    close: 'Закрыть',
    readOnly: 'Открыть для чтения',
    errors: {
      'no-file': 'Нет доски. Откройте её из «Файлов»: меню файла → «Открыть в Доске».',
      'no-origin': 'Эта версия панели облака не умеет показывать доску. Обновите RustCloud.',
      'no-service-url':
        'Доска не настроена: администратор указывает адрес сервиса доски в «Администрирование → Плагины → Доска».',
      unsupported: 'Это не файл доски (.excalidraw, .whiteboard).',
      'not-found': 'Доска больше не открыта для приложения. Откройте её заново из «Файлов».',
      retry: 'Права на файл изменились. Попробуйте ещё раз.',
      'frame-failed': 'Панель не разрешила показать доску.',
      'frame-timeout':
        'Доска не загрузилась. Сервис доски должен отвечать серверу облака по своему адресу («Администрирование → Плагины → Доска → Состояние»).',
      'load-failed': 'Не удалось открыть доску.',
      'not-a-board': 'Файл — не доска, которую может прочитать Excalidraw.',
      failed: 'Что-то пошло не так.',
    },
    lockedByUser: 'Эту доску сейчас редактирует другой пользователь. Пока он её не закроет, её можно открыть только для чтения.',
    lockedByApp: (app) =>
      `Доска сейчас редактируется в приложении «${app}». Пока оно не закончит, её можно открыть только для чтения.`,
  },
};

/** Texts for a locale, English if there are none. */
function texts(locale) {
  return TEXTS[locale] ?? TEXTS.en;
}

/** An element with attributes and children (text or elements). */
function h(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name === 'onclick') element.addEventListener('click', value);
    else if (value !== null && value !== undefined && value !== false) element.setAttribute(name, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined && child !== false) {
      element.append(child instanceof Node ? child : String(child));
    }
  }
  return element;
}
