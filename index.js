require('dotenv').config();
const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');
const cron = require('node-cron');

// Проверяем критические переменные окружения
if (!process.env.BOT_TOKEN || !process.env.MONGO_URI) {
    console.error('❌ Критическая ошибка: Не заданы BOT_TOKEN или MONGO_URI в переменных окружения!');
    process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// ==========================================
// 1. СХЕМЫ И МОДЕЛИ БАЗЫ ДАННЫХ (MONGOOSE)
// ==========================================

// Схема для пользователей
const userSchema = new mongoose.Schema({
    userId: { type: Number, unique: true, required: true },
    username: String,
    firstName: String,
    lastName: String
});
const User = mongoose.model('User', userSchema);

// Схема для чатов (групп)
const chatSchema = new mongoose.Schema({
    chatId: { type: Number, unique: true, required: true },
    users: [Number] // Массив ID пользователей, которые активничали в этом чате
});
const Chat = mongoose.model('Chat', chatSchema);

// Схема для вопросов (дневных опросов)
const questionSchema = new mongoose.Schema({
    text: { type: String, required: true }
});
const Question = mongoose.model('Question', questionSchema);

// Схема для утренних приветствий бота
const greetingSchema = new mongoose.Schema({
    text: { type: String, required: true }
});
const Greeting = mongoose.model('Greeting', greetingSchema);

// Схема для реакций бота (ответов), когда пользователи здороваются С НИМ
const responseSchema = new mongoose.Schema({
    text: { type: String, required: true }
});
const Response = mongoose.model('Response', responseSchema);


// ==========================================
// 2. ПОДКЛЮЧЕНИЕ К БАЗЕ ДАННЫХ
// ==========================================
mongoose.connect(process.env.MONGO_URI)
    .then(async () => {
        console.log('🚀 Успешно подключились к облачной базе MongoDB Atlas!');
        await verifyDatabase();
    })
    .catch(err => {
        console.error('❌ Критическая ошибка подключения к БД:', err);
    });

// Функция просто выводит в логи текущую статистику из облака
async function verifyDatabase() {
    try {
        const qCount = await Question.countDocuments();
        const gCount = await Greeting.countDocuments();
        const rCount = await Response.countDocuments();
        const uCount = await User.countDocuments();
        const cCount = await Chat.countDocuments();

        console.log(`📊 Статистика базы данных в облаке:`);
        console.log(`   - Вопросов (коллекция questions): ${qCount}`);
        console.log(`   - Утренних приветствий (коллекция greetings): ${gCount}`);
        console.log(`   - Ответов на "привет" (коллекция responses): ${rCount}`);
        console.log(`   - Всего активных юзеров в базе: ${uCount}`);
        console.log(`   - Всего чатов отслеживается: ${cCount}`);
    } catch (error) {
        console.error('❌ Ошибка при проверке статистики БД:', error);
    }
}


// ==========================================
// 3. ФУНКЦИИ РАССЫЛКИ (ЛОГИКА ИЗ БД)
// ==========================================

// Функция отправки утреннего приветствия
// Функция отправки утреннего приветствия (с поддержкой секретной команды)
async function sendMorningGreeting(specificChatId = null) {
    try {
        let chats = [];
        
        // Если передан конкретный ID, отправляем только туда. Если нет — берем все чаты из базы (для Крона)
        if (specificChatId) {
            chats.push({ chatId: specificChatId });
        } else {
            chats = await Chat.find({});
        }

        if (chats.length === 0) return;

        // Берем 1 случайное приветствие напрямую из базы
        const randomGreeting = await Greeting.aggregate([{ $sample: { size: 1 } }]);
        const greetingText = randomGreeting[0] ? randomGreeting[0].text : "Доброе утро, чат! 👋";

        for (const chat of chats) {
            try {
                await bot.telegram.sendMessage(chat.chatId, greetingText);
            } catch (err) {
                console.error(`Не удалось отправить утреннее приветствие в чат ${chat.chatId}:`, err);
            }
        }
    } catch (error) {
        console.error('Ошибка при выполнении утренней рассылки:', error);
    }
}

// Функция отправки дневного вопроса (по крону или по команде /question)
async function sendDailyQuestion(specificChatId = null) {
    try {
        let chats = [];
        
        if (specificChatId) {
            let chat = await Chat.findOne({ chatId: specificChatId });
            if (!chat) {
                chat = await Chat.create({ chatId: specificChatId, users: [] });
            }
            chats.push(chat);
        } else {
            chats = await Chat.find({});
        }

        for (const chat of chats) {
            if (!chat.users || chat.users.length === 0) {
                if (specificChatId) {
                    await bot.telegram.sendMessage(
                        chat.chatId, 
                        "🤖 <b>Я еще никого не запомнил в этом чате!</b>\n\nЧтобы я мог выбрать жертву, участники должны написать сюда хотя бы по одному текстовому сообщению.", 
                        { parse_mode: 'HTML' }
                    );
                }
                continue;
            }

            // Берем случайного юзера из тех, кто писал в этот чат
            const randomUserId = chat.users[Math.floor(Math.random() * chat.users.length)];
            const dbUser = await User.findOne({ userId: randomUserId });
            const firstName = dbUser ? dbUser.firstName : 'Участник';

            // Достаем случайный вопрос напрямую из базы
            const randomDoc = await Question.aggregate([{ $sample: { size: 1 } }]);
            const questionText = randomDoc[0] ? randomDoc[0].text : "у меня кончились каверзные вопросы...";

            const mention = `<a href="tg://user?id=${randomUserId}">${firstName}</a>`;
            const text = `${mention}${questionText}`;

            try {
                await bot.telegram.sendMessage(chat.chatId, text, { parse_mode: 'HTML' });
            } catch (error) {
                console.error(`Не удалось отправить вопрос в чат ${chat.chatId}:`, error);
            }
        }
    } catch (dbError) {
        console.error('Ошибка получения данных для вопроса из БД:', dbError);
        if (specificChatId) {
            await bot.telegram.sendMessage(specificChatId, "❌ Ошибка при обращении к базе данных.");
        }
    }
}


// ==========================================
// 4. ТРИГГЕРЫ И КОМАНДЫ БОТА
// ==========================================

// Ручной вызов вопроса
bot.command('question', async (ctx) => {
    await sendDailyQuestion(ctx.chat.id);
});

// Слушаем текстовые сообщения для сбора базы юзеров и ответов на "привет"
bot.on('text', async (ctx) => {
    const { id: userId, username, first_name: firstName, last_name: lastName } = ctx.from;
    const chatId = ctx.chat.id;
    const messageText = ctx.message.text.toLowerCase();

    try {
        // 1. Сохраняем/обновляем пользователя в глобальной базе
        await User.findOneAndUpdate(
            { userId },
            { userId, username, firstName, lastName },
            { upsert: true, new: true }
        );

        // 2. Если сообщение из группы, привязываем пользователя к этому конкретному чату
        if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
            await Chat.findOneAndUpdate(
                { chatId },
                { 
                    $setOnInsert: { chatId },
                    $addToSet: { users: userId } 
                },
                { upsert: true }
            );
        }

        // 3. Логика ответов бота на приветствия участников
        const greetingWords = ['привет', 'хай', 'здарова', 'ку', 'доброе утро', 'дорова', 'салам', 'шалом'];
        const isGreeting = greetingWords.some(word => messageText.includes(word));

        if (isGreeting) {
            // Ищем случайный ответ в коллекции responses
            const randomResponse = await Response.aggregate([{ $sample: { size: 1 } }]);
            
            if (randomResponse[0]) {
                // Если в тексте из базы заготовлено место под имя (например, "{name}, привет!"), меняем его на имя юзера
                let replyText = randomResponse[0].text;
                replyText = replyText.replace('{name}', firstName);
                
                await ctx.reply(replyText);
            }
        }

    } catch (error) {
        console.error('Ошибка в обработчике сообщений:', error);
    }
});

// Секретная команда проверки утреннего приветствия (только для админов)
command('petuhPodjem', async (ctx) => {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;

    // В личке у бота админов нет, там команда сработает сразу
    if (ctx.chat.type === 'private') {
        await ctx.reply('☀️ Симуляция утра в личке:');
        await sendMorningGreeting(chatId);
        return;
    }

    try {
        // Проверяем статус пользователя в этом чате
        const member = await ctx.telegram.getChatMember(chatId, userId);
        const isAdmin = member.status === 'administrator' || member.status === 'creator';

        if (isAdmin) {
            console.log(`👤 Админ ${ctx.from.firstName} запустил секретную команду проверки утра.`);
            await sendMorningGreeting(chatId);
        } else {
            // Если пишет не админ — бот просто проигнорирует или можно втихаря ответить подколкой из базы
            const randomDoc = await Question.aggregate([{ $sample: { size: 1 } }]);
            const insult = randomDoc[0] ? randomDoc[0].text : "...";
            await ctx.reply(`Слышь, <a href="tg://user?id=${userId}">${ctx.from.firstName}</a>${insult} Чтобы петухов будить, сначала админку заслужи.`, { parse_mode: 'HTML' });
        }
    } catch (error) {
        console.error('Ошибка проверки прав для секретной команды:', error);
    }
});
// ==========================================
// 5. ПЛАНИРОВЩИК ЗАДАЧ (CRON)
// ==========================================

// Утреннее приветствие: каждый день в 09:00 по Берлину (Европе)
cron.schedule('0 9 * * *', () => {
    console.log('⏰ Сработал Крон: отправка утреннего приветствия...');
    sendMorningGreeting();
}, {
    scheduled: true,
    timezone: "Europe/Berlin"
});

// Дневной опрос: каждый день в 15:00 по Берлину (Европе)
cron.schedule('0 15 * * *', () => {
    console.log('⏰ Сработал Крон: отправка дневного вопроса...');
    sendDailyQuestion();
}, {
    scheduled: true,
    timezone: "Europe/Berlin"
});

// ==========================================
// 6. ЗАГЛУШКА ДЛЯ RENDER (ЧТОБЫ СЕРВЕР НЕ ПАДАЛ)
// ==========================================
const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running...');
});

server.listen(PORT, () => {
    console.log(`📡 Микро-сервер для Render запущен на порту ${PORT}`);
});

// Запуск бота
bot.launch().then(() => {
    console.log('🤖 Бот успешно запущен и слушает команды!');
});

// Плавная остановка при выключении сервера
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
