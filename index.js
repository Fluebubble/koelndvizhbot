// Добавили Markup для создания удобных кнопок
const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');
const http = require('http');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
    console.error("Ошибка: Переменная окружения BOT_TOKEN не задана!");
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const chatsData = {};
const userNames = {};

const STUPID_QUESTIONS = [
    "Если помидор — это фрукт, то является ли кетчуп вареньем?",
    "Почему круглые пиццы упаковывают в квадратные коробки и едят треугольниками?",
    "Если бы ты был супом, то каким и почему?",
    "Сколько подгузников нужно надеть на кота, чтобы он перестал тыгыдыкать ночью?",
    "Если чихнуть с открытыми глазами, они правда вылетят?",
    "Как думаешь, о чем грустят голуби?",
    "Что будет, если намочить сухой закон?",
    "Почему клей не прилипает к внутренней стороне тюбика?",
    "Если бы у тебя была третья нога, куда бы ты её прикрепил?",
    "Если колобок повесится, то на чём?",
    "Можно ли выпить за здоровье человека безалкогольное пиво, или это аннулирует пожелание?"
];

// Собираем базу активных участников
bot.on('message', async (ctx, next) => {
    const chat = ctx.chat;
    const from = ctx.from;

    if ((chat.type === 'group' || chat.type === 'supergroup') && !from.is_bot) {
        if (!chatsData[chat.id]) {
            chatsData[chat.id] = new Set();
        }
        chatsData[chat.id].add(from.id);
        userNames[from.id] = from.first_name || 'Тайный участник';
    }
    return next(); // Пропускаем сообщение дальше, чтобы не ломать команды
});

// Универсальная функция отправки вопроса. 
// Если chatId передан — отправляет в конкретный чат. Если нет — во все.
async function sendQuestion(specificChatId = null) {
    const chatsToIterate = specificChatId ? [specificChatId] : Object.keys(chatsData);

    for (const chatId of chatsToIterate) {
        const usersArray = Array.from(chatsData[chatId] || []);
        
        if (usersArray.length === 0) {
            if (specificChatId) {
                // Если вызвали вручную, но чат пустой
                await bot.telegram.sendMessage(chatId, "Я еще никого не запомнил в этом чате! Напишите что-нибудь, чтобы я вас увидел.");
            }
            continue;
        }

        const randomUserId = usersArray[Math.floor(Math.random() * usersArray.length)];
        const randomQuestion = STUPID_QUESTIONS[Math.floor(Math.random() * STUPID_QUESTIONS.length)];
        const firstName = userNames[randomUserId];

        const mention = `<a href="tg://user?id=${randomUserId}">${firstName}</a>`;
        const text = `🚨 <b>Внимание, опрос!</b> 🚨\n\n${mention}, отвечай не думая:\n<i>${randomQuestion}</i>`;

        try {
            // Отправляем сообщение вместе с инлайн-кнопкой
            await bot.telegram.sendMessage(chatId, text, { 
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    Markup.button.callback('🎲 Ещё вопрос!', 'trigger_random_question')
                ])
            });
        } catch (error) {
            console.error(`Не удалось отправить сообщение в чат ${chatId}:`, error);
        }
    }
}

// Перехватываем нажатие на кнопку «Ещё вопрос!»
bot.action('trigger_random_question', async (ctx) => {
    try {
        // Обязательно «отвечаем» на триггер, чтобы у пользователя пропал значок загрузки на кнопке
        await ctx.answerCbQuery();
        // Запускаем генерацию вопроса именно для этого чата
        await sendQuestion(ctx.chat.id);
    } catch (error) {
        console.error('Ошибка при обработке кнопки:', error);
    }
});

// Команда /question для ручного вызова в чате
bot.command('question', async (ctx) => {
    if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
        await sendQuestion(ctx.chat.id);
    } else {
        await ctx.reply("Эта команда работает только в групповых чатах!");
    }
});

// Планировщик (раз в день в 12:00)
cron.schedule('0 12 * * *', () => {
    console.log('Запуск авто-опроса по расписанию...');
    sendQuestion();
}, {
    scheduled: true,
    timezone: "Europe/Moscow" 
});

// Заглушка сервера для Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is alive!');
}).listen(PORT);

bot.launch().then(() => {
    console.log('Бот запущен. Доступна команда /question и кнопка интерактива!');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));