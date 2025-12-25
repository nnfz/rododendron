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
    exportToConfig: string;
    exportToConfigHelp: string;
    process: string;
    domain: string;
    domainkey: string;
    ipAddress: string;
    processName: string;
    routeVia: string;
    cancel: string;
    noRules: string;
    active: string;
    inactive: string;
    scan: string;
    runningProcesses: string;
    searchProcesses: string;
    loadingProcesses: string;
    type: string;
    target: string;
    action: string;
    status: string;
    actions: string;
    viaVpn: string;
    direct: string;
    noProcessesFound: string;
    searchRules: string;
    placeholder: {
      process: string;
      domain: string;
      domainkey: string;
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
    exportConfig: string;
    deleteConfig: string;
    snowfall: string;
    logs: string;
    mainSettings: string;
    autoConnect: string;
    autoLaunch: string;
    enableTun: string;
    startminimized: string;
    killSwitch: string;
    killSwitchHelp: string;
    advanced: string;
    logLevel: string;
    mtu: string;
    mtuHelp: string;
    checkUpdates: string;
    checkingUpdates: string;
    updateAvailable: string;
    upToDate: string;
    updateNow: string;
    installingUpdate: string;
    updateError: string;
    about: string;
    version: string;
    confirmDelete: string;
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
      exportToConfig: 'Save rules to config',
      exportToConfigHelp: 'Saves your current rules into a YAML config file you choose.',
      process: 'Process',
      domain: 'Domain',
      domainkey: 'Keyword',
      type: 'Type',
      target: 'Target',
      action: 'Action',
      status: 'Status',
      actions: 'Actions',
      searchRules: 'Search rules...',
      loadingProcesses: 'Loading processes...',
      ipAddress: 'IP Address',
      processName: 'Process name',
      routeVia: 'Route via',
      cancel: 'Cancel',
      active: 'Active',
      inactive: 'Inactive',
      noRules: 'No rules defined. Add a new rule.',
      scan: 'Scan',
      runningProcesses: 'Running Processes',
      searchProcesses: 'Search processes...',
      viaVpn: 'Via VPN',
      direct: 'Direct',
      noProcessesFound: 'No processes found',
      placeholder: {
        process: 'chrome.exe',
        domain: 'google.com',
        domainkey: 'youtube',
        ip: '8.8.8.8',
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
      exportConfig: 'Export configuration',
      deleteConfig: 'Delete configuration',
      mainSettings: 'Main Settings',
      autoConnect: 'Auto connect',
      startminimized: 'Start minimized',
      snowfall: 'Snowfall',
      autoLaunch: 'Auto launch',
      confirmDelete: 'Are you sure?',
      killSwitch: 'Kill Switch',
      killSwitchHelp: 'Blocks internet access when VPN is disconnected to prevent traffic leaks.',
      advanced: 'Advanced',
      logLevel: 'Log level',
      enableTun: 'Enable TUN',
      mtu: 'MTU',
      mtuHelp: 'Maximum packet size. Lower it if you have connection issues; 1500 is default.',
      checkUpdates: 'Check for updates',
      checkingUpdates: 'Checking...',
      updateAvailable: 'Update available',
      upToDate: 'Up to date',
      updateNow: 'Update',
      installingUpdate: 'Installing...',
      updateError: 'Update error',
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
      exportToConfig: 'Сохранить правила в конфиг',
      exportToConfigHelp: 'Сохраняет текущие правила в YAML-конфиг, который ты выберешь.',
      process: 'Процесс',
      domain: 'Домен',
      type: 'Тип',
      target: 'Цель',
      action: 'Действие',
      status: 'Статус',
      actions: 'Действия',
      searchRules: 'Поиск правил...',
      loadingProcesses: 'Загрузка процессов...',
      domainkey: 'Кейворд',
      ipAddress: 'IP адрес',
      processName: 'Имя процесса',
      routeVia: 'Маршрут через',
      cancel: 'Отмена',
      noRules: 'Правила не заданы. Добавьте новое правило.',
      active: 'Активно',
      inactive: 'Неактивно',
      scan: 'Сканировать',
      runningProcesses: 'Запущенные процессы',
      
      searchProcesses: 'Поиск процессов...',
      viaVpn: 'Через VPN',
      direct: 'Напрямую',
      noProcessesFound: 'Процессы не найдены',
      placeholder: {
        process: 'chrome.exe',
        domain: 'google.com',
        domainkey: 'youtube',
        ip: '8.8.8.8',
      },
    },
    settings: {
      title: 'Настройки',
      configuration: 'Конфигурация',
      activeConfig: 'Активный конфиг',
      language: 'Язык',
      importConfig: 'Импорт конфигурации',
      exportConfig: 'Экспорт конфигурации',
      deleteConfig: 'Удалить конфигурацию',
      interfaceLanguage: 'Язык интерфейса',
      logsAndDiagnostics: 'Логи и диагностика',
      enableTun: 'Включить TUN',
      snowfall: 'Снежинки',
      logs: 'Логи',
      mainSettings: 'Основные настройки',
      autoLaunch: 'Автозапуск',
      startminimized: 'Запускать свёрнутым',
      confirmDelete: 'Вы уверены?',
      autoConnect: 'Автоподключение',
      killSwitch: 'Kill Switch',
      killSwitchHelp: 'Блокирует интернет при разрыве VPN, чтобы не было утечек трафика.',
      advanced: 'Продвинутые',
      logLevel: 'Уровень логов',
      mtu: 'MTU',
      mtuHelp: 'Макс. размер пакета. Уменьши, если есть проблемы с подключением; 1500 по умолчанию.',
      checkUpdates: 'Проверить обновления',
      checkingUpdates: 'Проверка...',
      updateAvailable: 'Доступно обновление',
      upToDate: 'Обновлений нет',
      updateNow: 'Обновить',
      installingUpdate: 'Установка...',
      updateError: 'Ошибка обновления',
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
      exportToConfig: 'Захаваць правілы ў канфіг',
      exportToConfigHelp: 'Захоўвае бягучыя правілы ў YAML-канфіг, які ты выберыш.',
      process: 'Працэс',
      type: 'Тып',
      target: 'Мэта',
      action: 'Дзеянне',
      status: 'Статус',
      actions: 'Дзеянні',
      searchRules: 'Пошук правілаў...',
      loadingProcesses: 'Загрузка процессов...',
      noProcessesFound: 'Няма даступных працэсаў',
      domain: 'Дамен',
      domainkey: 'Кейворд',
      ipAddress: 'IP адрас',
      processName: 'Імя працэсу',
      routeVia: 'Маршрут праз',
      cancel: 'Адмена',
      active: 'Актыўна',
      inactive: 'Неактыўна',
      noRules: 'Правілы не зададзеныя. Дадайце новае правіла.',
      scan: 'Сканаваць',
      runningProcesses: 'Запушчаныя працэсы',
      searchProcesses: 'Пошук працэсаў...',
      viaVpn: 'Праз VPN',
      direct: 'Напрамую',
      placeholder: {
        process: 'chrome.exe',
        domain: 'kufar.by',
        domainkey: 'kufar',
        ip: '8.8.8.8',
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
      exportConfig: 'Экспарт канфігурацыі',
      deleteConfig: 'Выдаліць канфігурацыю',
      enableTun: 'Уключыць TUN',
      logs: 'Логі',
      confirmDelete: 'Вы ўпэўнены?',
      snowfall: 'Сняжынкі',
      mainSettings: 'Асноўныя налады',
      autoLaunch: 'Аўтазапуск',
      autoConnect: 'Аўтападключэнне',
      startminimized: 'Запускаць згорнутым',
      killSwitch: 'Kill Switch',
      killSwitchHelp: 'Блакуе інтэрнэт пры разрыве VPN, каб не было ўцечак трафіку.',
      advanced: 'Пашыраныя',
      logLevel: 'Узровень логаў',
      mtu: 'MTU',
      mtuHelp: 'Макс. памер пакета. Паменшы, калі ёсць праблемы з падключэннем; 1500 па змаўчанні.',
      checkUpdates: 'Праверыць абнаўленні',
      checkingUpdates: 'Праверка...',
      updateAvailable: 'Даступна абнаўленне',
      upToDate: 'Абнаўленняў няма',
      updateNow: 'Абнавіць',
      installingUpdate: 'Устаноўка...',
      updateError: 'Памылка абнаўлення',
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
