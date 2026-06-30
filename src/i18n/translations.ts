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
    tags: string;
    allTags: string;
    manageTags: string;
    newTag: string;
    tagName: string;
    tagColor: string;
    copy: string;
    paste: string;
    noTags: string;
    noTagsYet: string;
    editRuleTags: string;
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
    opacity: string;
    more: string;
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
    editConfig: string;
    mainSettings: string;
    importurl: string;
    autoCheckUpdates: string;
    autoRestartOnRuleApply: string;
    autoConnect: string;
    autoLaunch: string;
    enableTun: string;
    startminimized: string;
    closeBehavior: string;
    closeToTray: string;
    closeExit: string;
    killSwitch: string;
    killSwitchHelp: string;
    advanced: string;
    logLevel: string;
    mtu: string;
    mtuHelp: string;
    tunStack: string;
    tunStackHelp: string;
    tunStackGvisor: string;
    tunStackMixed: string;
    tunStackSystem: string;
    fakeIpFilter: string;
    fakeIpFilterHelp: string;
    fakeIpFilterAdd: string;
    fakeIpFilterPlaceholder: string;
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
    clear: string;
  };
  welcome: {
    addConfigTitle: string;
    addConfigSubtitle: string;
    openSettings: string;
    continueWithoutConfig: string;
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
      restartvpn: 'Restart',
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
      tags: 'Tags',
      allTags: 'All',
      manageTags: 'Manage tags',
      newTag: 'New tag',
      tagName: 'Tag name',
      tagColor: 'Tag color',
      copy: 'Copy',
      paste: 'Paste',
      noTags: 'No tags',
      noTagsYet: 'No tags yet',
      editRuleTags: 'Rule tags',
      process: 'Process',
      domain: 'Domain',
      domainkey: 'Keyword',
      type: 'Type',
      target: 'Target',
      action: 'Action',
      status: 'Status',
      actions: 'Actions',
      searchRules: 'Search rules...',
      opacity: 'Opacity',
      more: 'More',
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
      importurl: 'Import from clipboard',
      autoCheckUpdates: 'Auto check updates',
      autoRestartOnRuleApply: 'Auto apply rules',
      importConfig: 'Import configuration',
      exportConfig: 'Export configuration',
      deleteConfig: 'Delete configuration',
      mainSettings: 'Main Settings',
      autoConnect: 'Auto connect',
      startminimized: 'Start minimized',
      editConfig: 'Edit config',
      closeBehavior: 'Close button behavior',
      closeToTray: 'Minimize to tray',
      closeExit: 'Exit app',
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
      tunStack: 'TUN Stack',
      tunStackHelp: 'gvisor — full userspace (stable). mixed — TCP via gvisor, UDP via system kernel (best for games). system — all via kernel.',
      tunStackGvisor: 'gvisor',
      tunStackMixed: 'mixed',
      tunStackSystem: 'system',
      fakeIpFilter: 'Fake-IP Filter',
      fakeIpFilterHelp: 'Domains bypassing Fake-IP. Games, STUN servers and OS connectivity checks should be here to avoid NAT issues.',
      fakeIpFilterAdd: 'Add domain',
      fakeIpFilterPlaceholder: '*.example.com',
      checkUpdates: 'Check for updates',
      checkingUpdates: 'Checking...',
      updateAvailable: 'Update available: v{version}',
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
      clear: 'Clear',
    },
    welcome: {
      addConfigTitle: 'Add a config',
      addConfigSubtitle: 'Without a config the app will not work.',
      openSettings: 'Open settings',
      continueWithoutConfig: 'Continue without config',
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
      restartvpn: 'Перезапустить',
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
      tags: 'Теги',
      allTags: 'Все',
      manageTags: 'Управление тегами',
      newTag: 'Новый тег',
      tagName: 'Имя тега',
      tagColor: 'Цвет',
      copy: 'Копировать',
      paste: 'Вставить',
      noTags: 'Без тегов',
      noTagsYet: 'Тегов пока нет',
      editRuleTags: 'Теги правила',
      process: 'Процесс',
      domain: 'Домен',
      type: 'Тип',
      target: 'Цель',
      action: 'Действие',
      status: 'Статус',
      actions: 'Действия',
      searchRules: 'Поиск правил...',
      opacity: 'Прозрачность',
      more: 'Больше',
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
      importurl: 'Вставить из буфера обмена',
      autoCheckUpdates: 'Автопроверка обновлений',
      interfaceLanguage: 'Язык интерфейса',
      logsAndDiagnostics: 'Логи и диагностика',
      enableTun: 'Включить TUN',
      snowfall: 'Снежинки',
      logs: 'Логи',
      editConfig: 'Редактировать конфиг',
      mainSettings: 'Основные настройки',
      autoLaunch: 'Автозапуск',
      startminimized: 'Запускать свёрнутым',
      confirmDelete: 'Вы уверены?',
      autoConnect: 'Автоподключение',
      closeBehavior: 'Поведение кнопки закрытия',
      closeToTray: 'Сворачивать в трей',
      closeExit: 'Закрывать приложение',
      killSwitch: 'Kill Switch',
      killSwitchHelp: 'Блокирует интернет при разрыве VPN, чтобы не было утечек трафика.',
      advanced: 'Продвинутые',
      logLevel: 'Уровень логов',
      mtu: 'MTU',
      mtuHelp: 'Макс. размер пакета. Уменьши, если есть проблемы с подключением; 1500 по умолчанию.',
      tunStack: 'Стек TUN',
      tunStackHelp: 'gvisor — полностью в юзерспейсе (стабильно). mixed — TCP через gvisor, UDP через ядро (лучше для игр). system — всё через ядро.',
      tunStackGvisor: 'gvisor',
      tunStackMixed: 'mixed',
      tunStackSystem: 'system',
      fakeIpFilter: 'Фильтр Fake-IP',
      fakeIpFilterHelp: 'Домены, обходящие Fake-IP. Игры, STUN-серверы и проверки ОС должны быть здесь для корректного NAT.',
      fakeIpFilterAdd: 'Добавить домен',
      fakeIpFilterPlaceholder: '*.example.com',
      checkUpdates: 'Проверить обновления',
      checkingUpdates: 'Проверка...',
      updateAvailable: 'Доступно обновление: v{version}',
      upToDate: 'Обновлений нет',
      updateNow: 'Обновить',
      installingUpdate: 'Установка...',
      updateError: 'Ошибка обновления',
      about: 'О программе',
      version: 'Версия',
      versioncore: 'Версия ядра',
      autoRestartOnRuleApply: 'Автоприменение правил',
    },
    logs: {
      title: 'Логи',
      export: 'Экспорт',
      clear: 'Очистить',
    },
    welcome: {
      addConfigTitle: 'Добавьте конфиг',
      addConfigSubtitle: 'Без конфига приложение не будет работать =(',
      openSettings: 'Открыть настройки',
      continueWithoutConfig: 'Пока без конфига',
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
      restartvpn: 'Перазапусціць',
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
      tags: 'Тэгі',
      allTags: 'Усе',
      manageTags: 'Кіраванне тэгамі',
      newTag: 'Новы тэг',
      tagName: 'Назва тэга',
      tagColor: 'Колер',
      copy: 'Капіяваць',
      paste: 'Уставіць',
      noTags: 'Без тэгаў',
      noTagsYet: 'Тэгаў пакуль няма',
      editRuleTags: 'Тэгі правіла',
      process: 'Працэс',
      type: 'Тып',
      target: 'Мэта',
      action: 'Дзеянне',
      status: 'Статус',
      actions: 'Дзеянні',
      searchRules: 'Пошук правілаў...',
      opacity: 'Празрыстасць',
      more: 'Больш',
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
      importurl: 'Уставіць з буфера абмену',
      autoCheckUpdates: 'Аўтапраўерка абнаўленняў',
      autoRestartOnRuleApply: 'Аўтапрымаўленне правіл',
      enableTun: 'Уключыць TUN',
      editConfig: 'Рэдагаваць конфиг',
      logs: 'Логі',
      confirmDelete: 'Вы ўпэўнены?',
      snowfall: 'Сняжынкі',
      mainSettings: 'Асноўныя налады',
      autoLaunch: 'Аўтазапуск',
      autoConnect: 'Аўтападключэнне',
      startminimized: 'Запускаць згорнутым',
      closeBehavior: 'Паводзіны кнопкі закрыцця',
      closeToTray: 'Згортваць у трей',
      closeExit: 'Закрываць праграму',
      killSwitch: 'Kill Switch',
      killSwitchHelp: 'Блакуе інтэрнэт пры разрыве VPN, каб не было ўцечак трафіку.',
      advanced: 'Пашыраныя',
      logLevel: 'Узровень логаў',
      mtu: 'MTU',
      mtuHelp: 'Макс. памер пакета. Паменшы, калі ёсць праблемы з падключэннем; 1500 па змаўчанні.',
      tunStack: 'Стэк TUN',
      tunStackHelp: 'gvisor — поўнасцю ў юзерспэйсе (стабільна). mixed — TCP праз gvisor, UDP праз ядро (лепш для гульняў). system — усё праз ядро.',
      tunStackGvisor: 'gvisor',
      tunStackMixed: 'mixed',
      tunStackSystem: 'system',
      fakeIpFilter: 'Фільтр Fake-IP',
      fakeIpFilterHelp: 'Дамены, якія абыходзяць Fake-IP. Гульні, STUN-серверы і праверкі ОС павінны быць тут для карэктнага NAT.',
      fakeIpFilterAdd: 'Дадаць дамен',
      fakeIpFilterPlaceholder: '*.example.com',
      checkUpdates: 'Праверыць абнаўленні',
      checkingUpdates: 'Праверка...',
      updateAvailable: 'Даступна абнаўленне: v{version}',
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
      clear: 'Очистіць',
    },
    welcome: {
      addConfigTitle: 'Дадайце канфіг',
      addConfigSubtitle: 'Без канфіга праграма не будзе працаваць.',
      openSettings: 'Адкрыць налады',
      continueWithoutConfig: 'Пакуль без канфіга',
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
