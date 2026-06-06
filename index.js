const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const http = require('http');
const mongoose = require('mongoose'); // Подключаем базу данных

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;

if (!BOT_TOKEN || !MONGO_URI) {
    console.error("Ошибка: Проверьте переменные окружения BOT_TOKEN и MONGO_URI!");
    process.exit(1);
}

// === ПОДКЛЮЧЕНИЕ К СЕТИ MONGODB ===
mongoose.connect(MONGO_URI)
    .then(() => console.log('Успешно подключились к облачной базе MongoDB Atlas!'))
    .catch(err => console.error('Критическая ошибка подключения к БД:', err));

// === СХЕМЫ ДАННЫХ ДЛЯ ХРАНЕНИЯ ===
// Схема для чатов (хранит ID группы, массив участников и ID утреннего посты)
const ChatSchema = new mongoose.Schema({
    chatId: { type: Number, required: true, unique: true },
    users: { type: [Number], default: [] },
    morningMessageId: { type: Number, default: null }
});
const Chat = mongoose.model('Chat', ChatSchema);

// Схема для пользователей (хранит реальные имена людей по их ID)
const UserSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    firstName: { type: String, default: 'Тайный участник' }
});
const User = mongoose.model('User', UserSchema);


// === БАЗА ДАННЫХ ДЛЯ ТЕКСТОВ ===
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

const REPLY_OPTIONS = [
    "Хуета",
    "Засчитано",
    "Хуета, но засчитано",
    "Ко-ко-ко🐓",
    "А ты хорош."
];

const bot = new Telegraf(BOT_TOKEN);

// === ЛОГИКА ОБРАБОТКИ СООБЩЕНИЙ ===
bot.on('message', async (ctx, next) => {
    const chat = ctx.chat;
    const from = ctx.from;
    const message = ctx.message;

    if ((chat.type === 'group' || chat.type === 'supergroup') && !from.is_bot) {
        try {
            // 1. Сохраняем/обновляем имя пользователя в глобальной базе
            await User.findOneAndUpdate(
                { userId: from.id },
                { firstName: from.first_name || 'Тайный участник' },
                { upsert: true }
            );

            // 2. Добавляем ID пользователя в список участников конкретного чата
            await Chat.findOneAndUpdate(
                { chatId: chat.id },
                { $addToSet: { users: from.id } },
                { upsert: true }
            );

            // 3. Проверка на реплай к утреннему приветствию
            if (message.reply_to_message) {
                const dbChat = await Chat.findOne({ chatId: chat.id });
                if (dbChat && dbChat.morningMessageId === message.reply_to_message.message_id) {
                    const randomReply = REPLY_OPTIONS[Math.floor(Math.random() * REPLY_OPTIONS.length)];
                    await ctx.reply(randomReply, { reply_to_message_id: message.message_id });
                }
            }
        } catch (error) {
            console.error('Ошибка работы с базой данных в обработчике:', error);
        }
    }
    return next();
});

// === РАССЫЛКА УТРЕННИХ ПРИВЕТСТВИЙ ===
async function sendMorningGreeting() {
    try {
        const chats = await Chat.find({});
        for (const chat of chats) {
            const randomGreeting = MORNING_GREETINGS[Math.floor(Math.random() * MORNING_GREETINGS.length)];
            try {
                const sentMsg = await bot.telegram.sendMessage(chat.chatId, randomGreeting);
                // Фиксируем ID сообщения в БД
                chat.morningMessageId = sentMsg.message_id;
                await chat.save();
            } catch (error) {
                console.error(`Не удалось отправить утреннее приветствие в чат ${chat.chatId}:`, error);
            }
        }
    } catch (dbError) {
        console.error('Ошибка получения чатов для утреннего приветствия:', dbError);
    }
}

// === РАССЫЛКА ДНЕВНЫХ ВОПРОСОВ ===
async function sendDailyQuestion(specificChatId = null) {
    try {
        const query = specificChatId ? { chatId: specificChatId } : {};
        const chats = await Chat.find(query);

        for (const chat of chats) {
            if (!chat.users || chat.users.length === 0) {
                if (specificChatId) {
                    await bot.telegram.sendMessage(chat.chatId, "Я еще никого не запомнил в этом чате! Напишите что-нибудь.");
                }
                continue;
            }

            const randomUserId = chat.users[Math.floor(Math.random() * chat.users.length)];
            const dbUser = await User.findOne({ userId: randomUserId });
            const firstName = dbUser ? dbUser.firstName : 'Тайный участник';

            const randomQuestion = STUPID_QUESTIONS[Math.floor(Math.random() * STUPID_QUESTIONS.length)];
            const mention = `<a href="tg://user?id=${randomUserId}">${firstName}</a>`;
            const text = `🚨 <b>Внимание, опрос!</b> 🚨\n\n${mention}, отвечай не думая:\n<i>${randomQuestion}</i>`;

            try {
                await bot.telegram.sendMessage(chat.chatId, text, { parse_mode: 'HTML' });
            } catch (error) {
                console.error(`Не удалось отправить дневной вопрос в чат ${chat.chatId}:`, error);
            }
        }
    } catch (dbError) {
        console.error('Ошибка получения данных из БД для дневного вопроса:', dbError);
    }
}

// Команда /question
bot.command('question', async (ctx) => {
    if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
        await sendDailyQuestion(ctx.chat.id);
    } else {
        await ctx.reply("Эта команда работает только в групповых чатах!");
    }
});

// КРОН 1: Утреннее приветствие (7:00 утра по Германии)
cron.schedule('0 7 * * *', () => {
    console.log('Запуск утреннего кукареканья...');
    sendMorningGreeting();
}, {
    scheduled: true,
    timezone: "Europe/Berlin" 
});

// КРОН 2: Дневной опрос (12:00 по Москве)
cron.schedule('0 12 * * *', () => {
    console.log('Запуск дневного опроса...');
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
    console.log('Бот успешно перезапущен с поддержкой постоянной базы данных MongoDB!');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
