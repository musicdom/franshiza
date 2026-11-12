# Норка — MAX Mini App

Норка — приложение с двумя внутренними балансами: ягодами и монетами.

## Архитектура

- **GitHub Pages** — статический интерфейс: `index.html` и каталог `Image/`.
- **Yandex Cloud Function** — единая серверная точка входа: `https://functions.yandexcloud.net/d4erur78tndi5tkkafn0`.
- **Redis / Upstash** — единое хранилище состояния, кошельков, заданий, розыгрышей и платежей.
- **MAX** — бот и Mini App; webhook зарегистрирован на Yandex Cloud.
- **YooMoney** — создание платёжных заказов и уведомления об оплате через Yandex Cloud.

Vercel не используется приложением. Не возвращайте в frontend ссылки на `*.vercel.app` и не добавляйте Vercel Cron.

## Маршруты Yandex Cloud Function

Все HTTP-запросы идут на один URL с параметром `route`:

| Маршрут | Назначение |
| --- | --- |
| `?route=norka` | Основной API приложения и административные действия |
| `?route=payment` | Создание и проверка платёжного заказа |
| `?route=yoomoney-notify` | Подписанное уведомление YooMoney |
| `?route=webhook` | События бота MAX |
| `?route=track-user` | Уведомление о запуске Mini App |
| `?route=setup-webhook` | Страница регистрации webhook MAX |
| `?route=cron-norka` | Ежедневные напоминания и обработка жизненного цикла розыгрышей |
| `/health` | Проверка доступности Redis |

## Переменные окружения Yandex Cloud

Задайте переменные в настройках функции. Секреты не добавляйте в GitHub:

**Обязательные для основной работы**
- `MAX_BOT_TOKEN`
- `MAX_WEBHOOK_SECRET`
- `KV_REST_API_URL` и `KV_REST_API_TOKEN` (либо `UPSTASH_REDIS_REST_URL` и `UPSTASH_REDIS_REST_TOKEN`)
- `NORKA_ADMIN_PASSWORD`

**Платежи YooMoney**
- `YOOMONEY_RECEIVER`
- `YOOMONEY_NOTIFICATION_SECRET`

**Cron**
- `CRON_SECRET` — секрет для ручного HTTP-вызова cron. Для Timer Trigger диспетчер добавляет этот bearer-секрет только при обработке внутреннего события Yandex Cloud.

**Дополнительные**
- `MAX_ADMIN_CHAT_ID`, `MAX_ADMIN_USER_ID`, `MAX_OWNER_USER_ID`
- `MAX_BOT_USERNAME`
- `NORKA_CHANNEL_URL`
- `NORKA_MINI_APP_URL`
- `NORKA_CRON_SECRET`
- `NORKA_ALLOWED_LINK_DOMAINS`
- `NORKA_AI_ENABLED=true` и `OPENAI_API_KEY` — для генеративных ответов группового помощника
- `NORKA_AI_MODEL` — необязательно, по умолчанию используется модель, заданная кодом

Не публикуйте значения этих переменных в чатах, issue, логах или файлах репозитория.

## Ежедневный запуск через Yandex Timer Trigger

После публикации обновлённой функции создайте в Yandex Cloud **Timer Trigger**:

1. Выберите эту Cloud Function и сервисный аккаунт, которому разрешён вызов функции.
2. Установите расписание `0 0 * * *` (ежедневно в 00:00 UTC).
3. В payload укажите JSON: `{"route":"cron-norka"}`.
4. Сохраните триггер и проверьте первый запуск в журнале функции.
5. Убедитесь, что в логах есть завершение маршрута `cron-norka` и статистика отправки напоминаний.

Диспетчер распознаёт Timer Trigger по событию Yandex Cloud и передаёт cron-маршруту внутренний bearer-секрет из `CRON_SECRET`. Не создавайте второй триггер с тем же расписанием: параллельный запуск может привести к повторной обработке фоновых задач, несмотря на часть Redis-защит.

## YooMoney: обязательная настройка

В кабинете YooMoney укажите URL уведомлений:

`https://functions.yandexcloud.net/d4erur78tndi5tkkafn0?route=yoomoney-notify`

Проверьте, что используется актуальный секрет уведомлений, совпадающий с `YOOMONEY_NOTIFICATION_SECRET` в Yandex Cloud. После переключения выполните контрольный платёж и проверьте:
- заказ создаётся через `?route=payment`;
- YooMoney отправляет уведомление на Yandex Cloud;
- подпись проверяется;
- монеты и бонусы начисляются ровно один раз;
- повторная доставка одного уведомления не дублирует начисление.

До успешного контрольного платежа не отключайте старую настройку уведомлений.

## MAX webhook

Webhook должен быть зарегистрирован на:

`https://functions.yandexcloud.net/d4erur78tndi5tkkafn0?route=webhook`

Для повторной регистрации откройте маршрут `?route=setup-webhook` и используйте значение `MAX_WEBHOOK_SECRET`, установленное в Yandex Cloud. Убедитесь, что старая Vercel-подписка удалена.

## Функциональность

- Ягоды за ежедневную активность и задания.
- Обмен ягод на монеты по курсу из Redis.
- История операций и защита от повторных начислений.
- Розыгрыши, билеты, призы и административное управление.
- XP, уровни, серии посещений и достижения.
- Групповой помощник Норки с проверенной базой знаний.

## Проверки перед отключением Vercel

- [ ] GitHub Actions проходят на Node.js 22.
- [ ] Mini App открывается и все API-запросы идут на Yandex Cloud.
- [ ] Создание платежа работает через `?route=payment`.
- [ ] YooMoney callback переведён на `?route=yoomoney-notify` и подтверждён контрольным платежом.
- [ ] MAX webhook указывает на Yandex Cloud; старые Vercel-подписки удалены.
- [ ] Timer Trigger создан, выполняется один раз в сутки, cron-логи успешны.
- [ ] Redis доступен из функции, данные и начисления сохранены.
- [ ] После проверки удалены старые Vercel-проект, домен/alias и переменные, если они больше нигде не используются.

## Разработка

Локальные проверки:

```bash
node --check yandex-function.js
node --check api/norka.js
node --check api/norka-payment.js
node --check api/yoomoney/notify.js
node --check api/webhook.js
node --check api/track-user.js
node --check api/setup-webhook.js
node --check api/cron/norka.js
node tests/check-app.js
```

GitHub Actions выполняет синтаксические и статические проверки на Node.js 22.
