const RU = Object.freeze({
  appName: "LINKWATCH",
  signIn: "Войти",
  signOut: "Выйти",
  username: "Имя пользователя",
  password: "Пароль",
  map: "Карта",
  mapCurrent: "Текущее состояние",
  mapHistorical: "Историческое evidence",
  mapLoading: "Загрузка карты…",
  mapUnavailable: "Операционные данные недоступны",
  registryLoading: "Реестр загружается…",
  registryUnavailable: "Реестр недоступен",
  notMonitored: "Не подключена к мониторингу",
});

export function createI18n({ locale = "ru", messages = { ru: RU } } = {}) {
  let currentLocale = locale;
  return {
    get locale() { return currentLocale; },
    setLocale(nextLocale) { if (messages[nextLocale]) currentLocale = nextLocale; return currentLocale; },
    t(key, fallback = key) { return messages[currentLocale]?.[key] ?? fallback; },
    messages,
  };
}

export { RU as RU_MESSAGES };
