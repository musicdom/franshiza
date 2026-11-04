# Перенос модуля Норки в Yandex Cloud Functions

Эта папка содержит готовые файлы для копирования. Действующий код в корне репозитория не менялся.

## Что копировать

1. Всю папку norka-winner-publisher целиком — в корень исходников Yandex Cloud Function. Внутри должны оказаться publisher.js, winner-card.js и четыре файла winner-template.part*.b64.
2. Файл norka-winner-publisher/api-norka-integrated.js — вместо текущего api/norka.js. В Yandex он должен лежать именно по пути api/norka.js.
3. Зависимость sharp из package-root.example.json — в корневой package.json функции. Если package.json ещё нет, можно взять файл package-root.example.json за основу и назвать его package.json.

## Структура в корне функции

```text
function-root/
  package.json
  yandex-function.js
  api/
    norka.js
    norka-payment.js
    track-user.js
  lib/
    max-api.js
  certs/
    russian_trusted_root_ca.pem
    russian_trusted_root_ca_gost_2025.pem
  norka-winner-publisher/
    publisher.js
    winner-card.js
    winner-template.part01.b64
    winner-template.part02.b64
    winner-template.part03.b64
    winner-template.part04.b64
    ...
```

Runtime: Node.js 22. Yandex должен установить sharp из package.json при создании новой версии функции. Не загружайте node_modules с Windows или macOS.

## Отключение ответов на посты канала

Файл api-webhook-silent.js — это готовая версия текущего api/webhook.js с проверкой recipient.chat_type === "channel". Её нужно установить вместо api/webhook.js **в том сервисе, который сейчас принимает MAX webhook**.

Важное отличие: текущий yandex-function.js в репозитории маршрутизирует norka, payment и track-user, но не webhook. Поэтому не копируйте api-webhook-silent.js в Yandex вслепую: сначала замените webhook-файл именно в текущем месте его размещения. Логика личного диалога и /start сохраняется, обычные посты канала игнорируются.

## Что будет происходить

- Только завершённые розыгрыши типа numbers запускают публикацию.
- Все 1–25 победителей попадают на одну общую карточку.
- Карточка публикуется в канал из Redis norka:channel:chat_id.
- Под ней одна кнопка open_app на https://max.ru/se14711525_bot.
- Личные текстовые уведомления и сохранение призов остаются в существующей логике.
- Redis-lock и ключ публикации защищают от повторов при повторном lifecycle.

## Перед включением

Сначала создай новую версию функции и проверь health endpoint. Затем проведи тестовый розыгрыш с небольшим числом победителей. Полный реальный тест отправки зависит от доступности MAX API, сертификатов и установленных зависимостей.
