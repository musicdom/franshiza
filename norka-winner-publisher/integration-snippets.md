# Подключение к api/norka.js

Папка изолирована: сама по себе она не запускается и не меняет действующую Норку. После копирования файлов в корень кода Yandex Cloud Function нужно подключить вызов в двух местах api/norka.js.

## 1. Импорт в начале api/norka.js

Добавить рядом с остальными require:

\`\`\`js
const { publishNumberedGiveawayWinners } = require("../norka-winner-publisher/publisher");
\`\`\`

Путь предполагает, что папка norka-winner-publisher лежит в корне функции рядом с папками api, lib и certs.

## 2. После сохранения результата розыгрыша

В drawNumberedGiveaway(giveawayId) вызов должен находиться только после saved === 1, то есть после атомарной записи status: "completed" и winners в Redis.

После существующих вызовов выдачи призов и личных уведомлений добавить:

\`\`\`js
await publishNumberedGiveawayWinners({
  item: completed,
  redisCommand: redis
});
\`\`\`

Это не заменяет личные уведомления и не отправляет картинку победителям в личку.

## 3. Повторная попытка из lifecycle

В ветке item.type === "numbers" && item.status === "completed" после выдачи наград и личных уведомлений добавить:

\`\`\`js
await publishNumberedGiveawayWinners({
  item,
  redisCommand: redis
});
\`\`\`

Модуль хранит отметку norka:winner-post:published:<giveawayId> и блокировку публикации в Redis. Повторный lifecycle не создаст вторую карточку после успешной отправки. При временной ошибке отметка успеха не ставится — следующий lifecycle попробует снова.

## 4. Зависимость

В корне загружаемого кода функции должен находиться package.json из этой папки (его содержимое нужно объединить с корневым package.json, если он уже есть). Для Yandex Cloud Functions используйте runtime Node.js 22. При публикации новой версии Yandex устанавливает зависимости из package.json. Не загружайте node_modules с компьютера другой операционной системы.

## Важно

- Не добавлять этот вызов в обработчик обычных сообщений канала.
- Не вызывать публикацию для розыгрышей другого типа.
- Канал берётся из Redis norka:channel:chat_id.
- Бот-токен берётся из MAX_BOT_TOKEN.
- Сертификаты MAX читаются из корневой папки certs/, как в текущем backend.
- Кнопка использует настоящий MAX open_app с адресом бота Норки https://max.ru/se14711525_bot.
