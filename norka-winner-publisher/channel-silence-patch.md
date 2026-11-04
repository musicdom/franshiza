# Отключение ответов Норки на посты канала

Файл, который нужно изменить в проекте: api/webhook.js.

Внутри блока:

if (type === "message_created") {

сразу после получения объекта сообщения:

const m = u.message || {}, sender = m.sender || {}, text = ...

добавить проверку:

```js
if (m.recipient?.chat_type === "channel") {
  return json(res, 200, { ok: true, ignored: "channel_post" });
}
```

Проверка должна стоять до sender.is_bot и до обработки команд. У обычных сообщений в личном диалоге остаётся текущая логика, включая /start. Для постов канала обработчик сразу завершает работу и ничего не публикует.

Основание: официальная схема MAX Message указывает recipient.chat_type = "channel" для канала; sender может отсутствовать, когда сообщение опубликовано непосредственно в канал.

Ссылки на документацию:
- https://dev.max.ru/docs-api/objects/Message
- https://dev.max.ru/docs-api/objects/Update
