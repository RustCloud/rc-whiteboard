// The board's own texts (Excalidraw translates itself, by langCode).
const TEXTS = {
  en: {
    close: 'Close',
    saved: 'Saved',
    saving: 'Saving…',
    dirty: 'Not saved yet',
    notSaved: 'Not saved',
    readOnly: 'Read-only',
    loading: 'Opening the board…',
    readOnlyWhy: {
      requested: 'Opened read-only.',
      'no-permission': 'You may only view this board.',
      'locked-by-user': 'Someone else is editing this board: you see it as it was opened, read-only.',
      'locked-by-app': (app) => `The app “${app}” is editing this board: read-only until it is done.`,
    },
    errors: {
      offline: 'No connection to the cloud: saving again in a moment.',
      failed: 'The cloud did not save the board: trying again in a moment.',
      'too-large': 'The board is larger than the cloud accepts. Remove some pictures or download a copy.',
      'no-space': 'No space left (quota or disk). Free some space or download a copy.',
      'not-found': 'The board is not open for the Whiteboard any more. Download a copy and open it again from Files.',
    },
    changed: {
      title: 'The file changed in the cloud',
      text: 'Someone saved this board outside the Whiteboard while it was open. Your changes since then are not saved.',
      reload: 'Load theirs (drop mine)',
      overwrite: 'Keep mine (overwrite)',
    },
    lost: {
      self: 'This board was opened in another tab or window: editing goes on there. Here it is read-only now.',
      user: 'Someone else took over this board. It is read-only here now.',
      app: (app) => `The app “${app}” took over this board. It is read-only here now.`,
      readOnly: 'You may not change this board any more. It is read-only now.',
      unsaved: 'Your last changes are not saved: download them as a copy.',
    },
    closeUnsaved: {
      title: 'The board is not saved',
      text: 'Closing now loses the last changes.',
      stay: 'Stay',
      closeAnyway: 'Close without saving',
    },
    download: 'Download a copy',
    dismiss: 'OK',
    noSession: 'Open boards from Files: the menu of a .excalidraw file → “Open in Whiteboard”.',
  },
  ru: {
    close: 'Закрыть',
    saved: 'Сохранено',
    saving: 'Сохранение…',
    dirty: 'Есть несохранённые изменения',
    notSaved: 'Не сохранено',
    readOnly: 'Только чтение',
    loading: 'Открываем доску…',
    readOnlyWhy: {
      requested: 'Открыто только для чтения.',
      'no-permission': 'Эту доску вам можно только смотреть.',
      'locked-by-user': 'Доску сейчас редактирует другой пользователь: вы видите её такой, какой она была при открытии.',
      'locked-by-app': (app) => `Доску сейчас меняет приложение «${app}»: пока оно не закончит, только чтение.`,
    },
    errors: {
      offline: 'Нет связи с облаком: сохраним чуть позже.',
      failed: 'Облако не сохранило доску: попробуем ещё раз чуть позже.',
      'too-large': 'Доска больше, чем принимает облако. Уберите часть картинок или скачайте копию.',
      'no-space': 'Нет места (квота или диск). Освободите место или скачайте копию.',
      'not-found': 'Доска больше не открыта для приложения. Скачайте копию и откройте доску заново из «Файлов».',
    },
    changed: {
      title: 'Файл изменился в облаке',
      text: 'Пока доска была открыта, её сохранили в обход Доски. Ваши изменения с того момента не сохранены.',
      reload: 'Загрузить их версию (мои пропадут)',
      overwrite: 'Оставить мою (перезаписать)',
    },
    lost: {
      self: 'Эту доску открыли в другой вкладке или окне: правка продолжается там. Здесь теперь только чтение.',
      user: 'Доску перехватил другой пользователь. Здесь теперь только чтение.',
      app: (app) => `Доску перехватило приложение «${app}». Здесь теперь только чтение.`,
      readOnly: 'Менять эту доску вам больше нельзя. Теперь только чтение.',
      unsaved: 'Последние изменения не сохранены: скачайте их копией.',
    },
    closeUnsaved: {
      title: 'Доска не сохранена',
      text: 'Если закрыть сейчас, последние изменения пропадут.',
      stay: 'Остаться',
      closeAnyway: 'Закрыть без сохранения',
    },
    download: 'Скачать копию',
    dismiss: 'Понятно',
    noSession: 'Доски открываются из «Файлов»: меню файла .excalidraw → «Открыть в Доске».',
  },
};

export function texts(lang) {
  return TEXTS[lang] ?? TEXTS.en;
}

/** Excalidraw's language code for the panel's. */
export function excalidrawLang(lang) {
  return lang === 'ru' ? 'ru-RU' : 'en';
}

/** A text that may take an argument. */
export function say(text, arg) {
  return typeof text === 'function' ? text(arg) : text;
}
