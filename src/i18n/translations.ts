export type Translations = {
  sidebar: {
    title: string;
    subtitle: string;
    home: string;
    rules: string;
    settings: string;
    status: string;
    connected: string;
    disconnected: string;
  };
  home: {
    connectionEstablished: string;
    notConnected: string;
    server: string;
    restartvpn: string;
    ip: string;
    latency: string;
    uptime: string;
    upload: string;
    download: string;
    core: string;
  };
  rules: {
    title: string;
    addRule: string;
    process: string;
    domain: string;
    domainkey: string;
    ipAddress: string;
    processName: string;
    routeVia: string;
    cancel: string;
    active: string;
    inactive: string;
    scan: string;
    runningProcesses: string;
    searchProcesses: string;
    viaVpn: string;
    direct: string;
    placeholder: {
      process: string;
      domain: string;
      ip: string;
    };
  };
  settings: {
    title: string;
    configuration: string;
    activeConfig: string;
    language: string;
    interfaceLanguage: string;
    logsAndDiagnostics: string;
    importConfig: string;
    deleteConfig: string;
    logs: string;
    mainSettings: string;
    autoConnect: string;
    autoLaunch: string;
    startminimized: string;
    killSwitch: string;
    advanced: string;
    logLevel: string;
    mtu: string;
    about: string;
    version: string;
    versioncore: string;
  };
  logs: {
    title: string;
    export: string;
  };
  common: {
    save: string;
    edit: string;
    delete: string;
    close: string;
    minimize: string;
    maximize: string;
  };
  select: {
    none: string;
  };
};

export const translations: Record<Language, Translations> = {
  en: {
    sidebar: {
      title: 'Rododendron',
      subtitle: 'nnfz',
      home: 'Home',
      rules: 'Rules',
      settings: 'Settings',
      status: 'Status',
      connected: 'Connected',
      disconnected: 'Disconnected',
    },
    home: {
      connectionEstablished: 'Connection established',
      notConnected: 'Not connected',
      server: 'Server',
      restartvpn: 'Restart VPN',
      ip: 'IP',
      latency: 'Latency',
      uptime: 'Uptime',
      upload: 'Upload',
      download: 'Download',
      core: 'Core',
    },
    rules: {
      title: 'Routing Rules',
      addRule: 'Add Rule',
      process: 'Process',
      domain: 'Domain',
      domainkey: 'Keyword',
      ipAddress: 'IP Address',
      processName: 'Process name',
      routeVia: 'Route via',
      cancel: 'Cancel',
      active: 'Active',
      inactive: 'Inactive',
      scan: 'Scan',
      runningProcesses: 'Running Processes',
      searchProcesses: 'Search processes...',
      viaVpn: 'Via VPN',
      direct: 'Direct',
      placeholder: {
        process: 'e.g., chrome.exe',
        domain: 'e.g., google.com',
        ip: 'e.g., 8.8.8.8',
      }
    },
    settings: {
      title: 'Settings',
      configuration: 'Configuration',
      activeConfig: 'Active config',
      language: 'Language',
      interfaceLanguage: 'Interface language',
      logsAndDiagnostics: 'Logs and diagnostics',
      logs: 'Logs',
      importConfig: 'Import configuration',
      deleteConfig: 'Delete configuration',
      mainSettings: 'Main Settings',
      autoConnect: 'Auto connect',
      startminimized: 'Start minimized',
      autoLaunch: 'Auto launch',
      killSwitch: 'Kill Switch',
      advanced: 'Advanced',
      logLevel: 'Log level',
      mtu: 'MTU',
      about: 'About',
      version: 'Version',
      versioncore: 'Core version',
    },
    logs: {
      title: 'Application Logs',
      export: 'Export',
    },
    common: {
      save: 'Save',
      edit: 'Edit',
      delete: 'Delete',
      close: 'Close',
      minimize: 'Minimize',
      maximize: 'Maximize',
    },
    select: {
      none: 'None',
    }
  },
  ru: {
    sidebar: {
      title: 'Rododendron',
      subtitle: 'nnfz',
      home: 'Главная',
      rules: 'Правила',
      settings: 'Настройки',
      status: 'Статус',
      connected: 'Подключено',
      disconnected: 'Отключено',
    },
    home: {
      connectionEstablished: 'Соединение установлено',
      notConnected: 'Не подключено',
      server: 'Сервер',
      restartvpn: 'Перезапустить VPN',
      ip: 'IP',
      latency: 'Задержка',
      uptime: 'Время работы',
      upload: 'Отправлено',
      download: 'Получено',
      core: 'Ядро',
    },
    rules: {
      title: 'Правила маршрутизации',
      addRule: 'Добавить правило',
      process: 'Процесс',
      domain: 'Домен',
      domainkey: 'Ключевое слово',
      ipAddress: 'IP адрес',
      processName: 'Имя процесса',
      routeVia: 'Маршрут через',
      cancel: 'Отмена',
      active: 'Активно',
      inactive: 'Неактивно',
      scan: 'Сканировать',
      runningProcesses: 'Запущенные процессы',
      searchProcesses: 'Поиск процессов...',
      viaVpn: 'Через VPN',
      direct: 'Напрямую',
      placeholder: {
        process: 'например, chrome.exe',
        domain: 'например, google.com',
        ip: 'например, 8.8.8.8',
      },
    },
    settings: {
      title: 'Настройки',
      configuration: 'Конфигурация',
      activeConfig: 'Активный конфиг',
      language: 'Язык',
      importConfig: 'Импорт конфигурации',
      deleteConfig: 'Удалить конфигурацию',
      interfaceLanguage: 'Язык интерфейса',
      logsAndDiagnostics: 'Логи и диагностика',
      logs: 'Логи',
      mainSettings: 'Основные настройки',
      autoLaunch: 'Автозапуск',
      startminimized: 'Запускать свёрнутым',
      autoConnect: 'Автоподключение',
      killSwitch: 'Kill Switch',
      advanced: 'Расширенные',
      logLevel: 'Уровень логов',
      mtu: 'MTU',
      about: 'О программе',
      version: 'Версия',
      versioncore: 'Версия ядра',
    },
    logs: {
      title: 'Логи приложения',
      export: 'Экспорт',
    },
    common: {
      save: 'Сохранить',
      edit: 'Редактировать',
      delete: 'Удалить',
      close: 'Закрыть',
      minimize: 'Свернуть',
      maximize: 'Развернуть',
    },
    select: {
      none: 'Нет',
    }
  },
  be: {
    sidebar: {
      title: 'Rododendron',
      subtitle: 'nnfz',
      home: 'Галоўная',
      rules: 'Правілы',
      settings: 'Налады',
      status: 'Статус',
      connected: 'Падключана',
      disconnected: 'Адключана',
    },
    home: {
      connectionEstablished: 'Злучэнне ўстаноўлена',
      notConnected: 'Не падключана',
      server: 'Сервер',
      ip: 'IP',
      restartvpn: 'Перазапусціць VPN',
      latency: 'Затрымка',
      uptime: 'Час працы',
      upload: 'Адпраўлена',
      download: 'Атрымана',
      core: 'Ядро',
    },
    rules: {
      title: 'Правілы маршрутызацыі',
      addRule: 'Дадаць правіла',
      process: 'Працэс',
      domain: 'Дамен',
      domainkey: 'Ключавое слова',
      ipAddress: 'IP адрас',
      processName: 'Імя працэсу',
      routeVia: 'Маршрут праз',
      cancel: 'Адмена',
      active: 'Актыўна',
      inactive: 'Неактыўна',
      scan: 'Сканаваць',
      runningProcesses: 'Запушчаныя працэсы',
      searchProcesses: 'Пошук працэсаў...',
      viaVpn: 'Праз VPN',
      direct: 'Напрамую',
      placeholder: {
        process: 'напрыклад, chrome.exe',
        domain: 'напрыклад, google.com',
        ip: 'напрыклад, 8.8.8.8',
      },
    },
    settings: {
      title: 'Налады',
      configuration: 'Канфігурацыя',
      activeConfig: 'Актыўны канфіг',
      language: 'Мова',
      interfaceLanguage: 'Мова інтэрфейсу',
      logsAndDiagnostics: 'Логі і дыягностыка',
      importConfig: 'Імпарт канфігурацыі',
      deleteConfig: 'Выдаліць канфігурацыю',
      logs: 'Логі',
      mainSettings: 'Асноўныя налады',
      autoLaunch: 'Аўтазапуск',
      autoConnect: 'Аўтападключэнне',
      startminimized: 'Запускаць згорнутым',
      killSwitch: 'Kill Switch',
      advanced: 'Пашыраныя',
      logLevel: 'Узровень логаў',
      mtu: 'MTU',
      about: 'Пра праграму',
      version: 'Версія',
      versioncore: 'Версія ядра',
    },
    logs: {
      title: 'Логі праграмы',
      export: 'Экспарт',
    },
    common: {
      save: 'Захаваць',
      edit: 'Рэдагаваць',
      delete: 'Выдаліць',
      close: 'Закрыць',
      minimize: 'Згарнуць',
      maximize: 'Разгарнуць',
    },
    select: {
      none: 'Няма',
    }
  },
};

export type Language = 'en' | 'ru' | 'be';
