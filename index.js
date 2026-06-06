const { Telegraf } = require('telegraf');
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
const morningMessages = {}; // Здесь храним ID утренних сообщений для каждого чата

// База глупых дневных вопросов
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

// Твои утренние приветствия
const MORNING_GREETINGS = [
    "Доброе утро, петушары. Кто не ответит мне тем же, тот сегодня останется без комбикорма и без курочек.",
    "Доброе утро, петушары. Кто не ответит, тот весь день будет кукарекать в пустой курятник.",
    "Доброе утро, петушары. Не поздороваетесь в ответ — пойдёте на шашлык первыми.",
    "Доброе утро, петушары. Кто промолчит, тому сегодня яйца не светят.",
    "Доброе утро, петушары. Без ответа будешь клевать землю вместо завтрака.",
    "Доброе утро, петушары. Не ответишь — весь день просидишь на насесте в одиночестве.",
    "Доброе утро, петушары. Кто не отзовётся, тот сегодня без зерна и уважения.",
    "Доброе утро, петушары. Игнор = автоматом в суп на обед.",
    "Доброе утро, петушары. Не ответите тем же — будете гулять по двору без хвоста.",
    "Доброе утро, петушары. Кто не поддержит, тот сегодня спит в гнезде для наседок."
];

// Ответы на реакцию пользователей
const REPLY_OPTIONS = [
    "Хуета",
    "Засчитано",
    "Хуета, но засчитано",
    "Ко-ко-ко🐓",
    "А ты хорош."
];

// Слушатель всех сообщений в чате
bot.on('message', async (ctx, next) => {
    const chat = ctx.chat;
    const from = ctx.from;
    const message = ctx.message;

    if ((chat.type === 'group' || chat.type === 'supergroup') && !from.is_bot) {
        // 1. Собираем базу активных участников
        if (!chatsData[chat.id]) {
            chatsData[chat.id] = new Set();
        }
        chatsData[chat.id].add(from.id);
        userNames[from.id] = from.first_name || 'Тайный участник';

        // 2. ПРОВЕРКА: это ответ на утреннее приветствие бота?
        if (message.reply_to_message) {
            const targetMorningId = morningMessages[chat.id];
            
            // Если ID сообщения, на которое ответили, совпадает с утренним ID в этом чате
            if (targetMorningId && message.reply_to_message.message_id === targetMorningId) {
                const randomReply = REPLY_OPTIONS[Math.floor(Math.random() * REPLY_OPTIONS.length)];
                try {
                    // Отвечаем именно на сообщение пользователя
                    await ctx.reply(randomReply, { reply_to_message_id: message.message_id });
                } catch (error) {
                    console.error('Ошибка при отправке утреннего ответа:', error);
                }
            }
        }
    }
    return next();
});

// Функция для рассылки утреннего кукареканья
async function sendMorningGreeting() {
    for (const chatId in chatsData) {
        const randomGreeting = MORNING_GREETINGS[Math.floor(Math.random() * MORNING_GREETINGS.length)];
        try {
            const sentMsg = await bot.telegram.sendMessage(chatId, randomGreeting);
            // Запоминаем ID этого сообщения для конкретного чата
            morningMessages[chatId] = sentMsg.message_id;
        } catch (error) {
            console.error(`Не удалось отправить утреннее приветствие в чат ${chatId}:`, error);
        }
    }
}

// Функция для дневного опроса
async function sendDailyQuestion(specificChatId = null) {
    const chatsToIterate = specificChatId ? [specificChatId] : Object.keys(chatsData);

    for (const chatId of chatsToIterate) {
        const usersArray = Array.from(chatsData[chatId] || []);
        if (usersArray.length === 0) continue;

        const randomUserId = usersArray[Math.floor(Math.random() * usersArray.length)];
        const randomQuestion = STUPID_QUESTIONS[Math.floor(Math.random() * STUPID_QUESTIONS.length)];
        const firstName = userNames[randomUserId];

        const mention = `<a href="tg://user?id=${randomUserId}">${firstName}</a>`;
        const text = `🚨 <b>Внимание, опрос!</b> 🚨\n\n${mention}, отвечай не думая:\n<i>${randomQuestion}</i>`;

        try {
            await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
        } catch (error) {
            console.error(`Не удалось отправить дневной вопрос в чат ${chatId}:`, error);
        }
    }
}

// Ручной вызов дневного опроса
bot.command('question', async (ctx) => {
    if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
        await sendDailyQuestion(ctx.chat.id);
    } else {
        await ctx.reply("Эта команда работает только в групповых чатах!");
    }
});

// КРОН 1: Утреннее приветствие (7:00 утра по времени Германии)
cron.schedule('0 7 * * *', () => {
    console.log('Запуск утреннего приветствия по Берлину...');
    sendMorningGreeting();
}, {
    scheduled: true,
    timezone: "Europe/Berlin" 
});

// КРОН 2: Дневной опрос (12:00 по Москве)
cron.schedule('0 12 * * *', () => {
    console.log('Запуск дневного опроса по Москве...');
    sendDailyQuestion();
}, {
    scheduled: true,
    timezone: "Europe/Moscow" 
});

// Серверная заглушка для Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is alive!');
}).listen(PORT);

bot.launch().then(() => {
    console.log('Бот успешно запущен со всеми обновлениями!');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
