const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const http = require('http');
const mongoose = require('mongoose');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;

if (!BOT_TOKEN || !MONGO_URI) {
    console.error("Ошибка: Проверьте переменные окружения BOT_TOKEN и MONGO_URI!");
    process.exit(1);
}

// === ПОДКЛЮЧЕНИЕ К MONGODB И АВТОПОСЕВ ===
mongoose.connect(MONGO_URI)
    .then(async () => {
        console.log('Успешно подключились к облачной базе MongoDB Atlas!');
        await seedDatabase(); // Запуск проверки и заполнения текстов
    })
    .catch(err => console.error('Критическая ошибка подключения к БД:', err));

// === СХЕМЫ ДАННЫХ ===

// Старые схемы (Динамические данные чата)
const ChatSchema = new mongoose.Schema({
    chatId: { type: Number, required: true, unique: true },
    users: { type: [Number], default: [] },
    morningMessageId: { type: Number, default: null }
});
const Chat = mongoose.model('Chat', ChatSchema);

const UserSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    firstName: { type: String, default: 'Тайный участник' }
});
const User = mongoose.model('User', UserSchema);

// Новые схемы (Для статичных текстов)
const QuestionSchema = new mongoose.Schema({ text: { type: String, required: true } });
const Question = mongoose.model('Question', QuestionSchema);

const GreetingSchema = new mongoose.Schema({ text: { type: String, required: true } });
const Greeting = mongoose.model('Greeting', GreetingSchema);


// === ИСХОДНЫЕ ДАННЫЕ ДЛЯ ПЕРВОГО ЗАПУСКА ===
const DEFAULT_QUESTIONS = [
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

const DEFAULT_GREETINGS = [
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

// Функция, которая наполняет пустую базу данных текстами при первом запуске
async function seedDatabase() {
    try {
        const qCount = await Question.countDocuments();
        if (qCount === 0) {
            await Question.insertMany(DEFAULT_QUESTIONS.map(t => ({ text: t })));
            console.log('🌱 База данных вопросов успешно инициализирована!');
        }

        const gCount = await Greeting.countDocuments();
        if (gCount === 0) {
            await Greeting.insertMany(DEFAULT_GREETINGS.map(t => ({ text: t })));
            console.log('🌱 База данных приветствий успешно инициализирована!');
        }
    } catch (err) {
        console.error('Ошибка при инициализации текстов в БД:', err);
    }
}

const bot = new Telegraf(BOT_TOKEN);

// === ЛОГИКА ОБРАБОТКИ СООБЩЕНИЙ ===
bot.on('message', async (ctx, next) => {
    const chat = ctx.chat;
    const from = ctx.from;
    const message = ctx.message;

    if ((chat.type === 'group' || chat.type === 'supergroup') && !from.is_bot) {
        try {
            await User.findOneAndUpdate(
                { userId: from.id },
                { firstName: from.first_name || 'Тайный участник' },
                { upsert: true }
            );

            await Chat.findOneAndUpdate(
                { chatId: chat.id },
                { $addToSet: { users: from.id } },
                { upsert: true }
            );

            if (message.reply_to_message) {
                const dbChat = await Chat.findOne({ chatId: chat.id });
                if (dbChat && dbChat.morningMessageId === message.reply_to_message.message_id) {
                    const randomReply = REPLY_OPTIONS[Math.floor(Math.random() * REPLY_OPTIONS.length)];
                    await ctx.reply(randomReply, { reply_to_message_id: message.message_id });
                }
            }
        } catch (error) {
            console.error('Ошибка в обработчике сообщений:', error);
        }
    }
    return next();
});

// === РАССЫЛКА УТРЕННИХ ПРИВЕТСТВИЙ ===
async function sendMorningGreeting() {
    try {
        const chats = await Chat.find({});
        if (chats.length === 0) return;

        for (const chat of chats) {
            // Берем 1 случайный документ из коллекции приветствий средствами MongoDB
            const randomDoc = await Greeting.aggregate([{ $sample: { size: 1 } }]);
            const greetingText = randomDoc[0] ? randomDoc[0].text : "Доброе утро, петушары!";

            try {
                const sentMsg = await bot.telegram.sendMessage(chat.chatId, greetingText);
                chat.morningMessageId = sentMsg.message_id;
                await chat.save();
            } catch (error) {
                console.error(`Не удалось отправить приветствие в чат ${chat.chatId}:`, error);
            }
        }
    } catch (dbError) {
        console.error('Ошибка получения приветствий из БД:', dbError);
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

            // Берем 1 случайный документ из коллекции вопросов средствами MongoDB
            const randomDoc = await Question.aggregate([{ $sample: { size: 1 } }]);
            const questionText = randomDoc[0] ? randomDoc[0].text : "Где вопросы?";

            const mention = `<a href="tg://user?id=${randomUserId}">${firstName}</a>`;
            const text = `🚨 <b>Внимание, опрос!</b> 🚨\n\n${mention}, отвечай не думая:\n<i>${questionText}</i>`;

            try {
                await bot.telegram.sendMessage(chat.chatId, text, { parse_mode: 'HTML' });
            } catch (error) {
                console.error(`Не удалось отправить дневной вопрос в чат ${chat.chatId}:`, error);
            }
        }
    } catch (dbError) {
        console.error('Ошибка получения вопросов из БД:', dbError);
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

// КРОН ПЛАНИРОВЩИКИ
cron.schedule('0 7 * * *', () => {
    console.log('Запуск утреннего кукареканья...');
    sendMorningGreeting();
}, { scheduled: true, timezone: "Europe/Berlin" });

cron.schedule('0 12 * * *', () => {
    console.log('Запуск дневного опроса...');
    sendDailyQuestion();
}, { scheduled: true, timezone: "Europe/Moscow" });

// Серверная заглушка для Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is alive!');
}).listen(PORT);

bot.launch().then(() => {
    console.log('Бот запущен. Тексты перенесены в полноценную базу данных.');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
