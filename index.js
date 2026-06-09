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
    users: [Number], // Массив ID пользователей, которые активничали в этом чате
    lastMessageAt: { type: Date, default: Date.now }, // Время последнего сообщения в чате
    questionSentToday: { type: Boolean, default: false } // Отправляли ли уже вопрос сегодня
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

// Функция отправки дневного вопроса (с поддержкой нескольких случайных имён)
async function sendDailyQuestion(specificChatId = null) {
    try {
        let chats = [];
        
        if (specificChatId) {
            let chat = await Chat.findOne({ chatId: specificChatId });
            if (!chat) {
                chat = await Chat.create({ chatId: specificChatId, users: [], lastMessageAt: new Date() });
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

            // 1. Достаем случайный вопрос напрямую из базы
            const randomDoc = await Question.aggregate([{ $sample: { size: 1 } }]);
            let questionText = randomDoc[0] ? randomDoc[0].text : "у меня кончились каверзные вопросы...";

            // 2. Перемешиваем массив пользователей чата (Алгоритм Фишера-Йетса)
            const shuffledUsers = [...chat.users];
            for (let i = shuffledUsers.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffledUsers[i], shuffledUsers[j]] = [shuffledUsers[j], shuffledUsers[i]];
            }

            // 3. Функция для создания кликабельного упоминания по userId
            const getMentionHtml = async (userId) => {
                const dbUser = await User.findOne({ userId });
                const name = dbUser ? dbUser.firstName : 'Участник';
                return `<a href="tg://user?id=${userId}">${name}</a>`;
            };

            // 4. Ищем и заменяем {name1}, {name2}, {name3} в тексте вопроса
            // Если в вопросе просто {name} (старый формат), он тоже заменится на первого юзера
            if (questionText.includes('{name1}') || questionText.includes('{name2}')) {
                if (shuffledUsers[0]) {
                    const mention1 = await getMentionHtml(shuffledUsers[0]);
                    questionText = questionText.replace(/{name1}/g, mention1);
                }
                if (shuffledUsers[1]) {
                    const mention2 = await getMentionHtml(shuffledUsers[1]);
                    questionText = questionText.replace(/{name2}/g, mention2);
                } else {
                    // Страховка: если в чате активен всего 1 человек, а вопросу нужно двое
                    const mentionBackup = await getMentionHtml(shuffledUsers[0]);
                    questionText = questionText.replace(/{name2}/g, `${mentionBackup} (и больше некому)`);
                }
            } else {
                // Старая логика: если в вопросе нет цифр, а есть просто {name}
                if (shuffledUsers[0]) {
                    const mention = await getMentionHtml(shuffledUsers[0]);
                    // Если в шаблоне базы вопрос идет БЕЗ {name} в начале (как было раньше), 
                    // проверяем, нужно ли принудительно прикреплять имя в начало строки
                    if (questionText.includes('{name}')) {
                        questionText = questionText.replace(/{name}/g, mention);
                    } else {
                        questionText = `${mention}${questionText}`;
                    }
                }
            }

            try {
                // Отправляем уже полностью сформированный текст с подставленными именами
                await bot.telegram.sendMessage(chat.chatId, questionText, { parse_mode: 'HTML' });
                
                // Переключаем флаг, что в этот чат вопрос сегодня УЖЕ ушел
                await Chat.updateOne({ chatId: chat.chatId }, { $set: { questionSentToday: true } });
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

// Секретная команда проверки утреннего приветствия (только для админов и создателя)
bot.command('petuhPodjem', async (ctx) => {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;

    // В личке у бота админов нет, там команда сработает сразу
    if (ctx.chat.type === 'private') {
        await ctx.reply('☀️ Симуляция утра в личке:');
        await sendMorningGreeting(chatId);
        return;
    }

    try {
        // Жесткая проверка: создатель группы
        if (ctx.from.username && ctx.from.username.toLowerCase() === 'anatoliy_trots'.toLowerCase()) {
            console.log(`👑 Создатель группы напрямую запустил команду.`);
            await sendMorningGreeting(chatId);
            return;
        }

        // Стандартная проверка для остальных админов
        const member = await ctx.telegram.getChatMember(chatId, userId);
        const isAdmin = member.status === 'administrator' || member.status === 'creator';

        if (isAdmin) {
            console.log(`👤 Админ ${ctx.from.firstName} запустил секретную команду проверки утра.`);
            await sendMorningGreeting(chatId);
        } else {
            const randomDoc = await Question.aggregate([{ $sample: { size: 1 } }]);
            const insult = randomDoc[0] ? randomDoc[0].text : "...";
            await ctx.reply(`Слышь, <a href="tg://user?id=${userId}">${ctx.from.firstName}</a>${insult} Чтобы петухов будить, сначала админку заслужи.`, { parse_mode: 'HTML' });
        }
    } catch (error) {
        console.error('❌ Ошибка проверки прав для секретной команды:', error);
        await ctx.reply('⚠️ Не удалось проверить права админа. Убедись, что бот является администратором группы!');
    }
});

// Ручной вызов вопроса
bot.command('question', async (ctx) => {
    await sendDailyQuestion(ctx.chat.id);
});

// Слушаем текстовые сообщения для сбора базы юзеров, обновления таймеров и ответов на реплаи
bot.on('text', async (ctx) => {
    const { id: userId, username, first_name: firstName, last_name: lastName } = ctx.from;
    const chatId = ctx.chat.id;

    try {
        // 1. Сохраняем/обновляем пользователя в глобальной базе
        await User.findOneAndUpdate(
            { userId },
            { userId, username, firstName, lastName },
            { upsert: true, new: true }
        );

        // 2. Если сообщение из группы, привязываем пользователя и обновляем время активности
        if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
            await Chat.findOneAndUpdate(
                { chatId },
                { 
                    $setOnInsert: { chatId },
                    $addToSet: { users: userId },
                    $set: { lastMessageAt: new Date() } // Фиксируем время сообщения для трекера тишины
                },
                { upsert: true }
            );
        }

        // 3. Логика ответов бота (СТРОГО НА ЛЮБОЙ РЕПЛАЙ К УТРЕННЕМУ ПРИВЕТСТВИЮ)
        const replyToMessage = ctx.message.reply_to_message;

        // Проверяем: это ответ на сообщение НАШЕГО бота?
        const isReplyToBot = replyToMessage && replyToMessage.from && replyToMessage.from.id === ctx.botInfo.id;

        if (isReplyToBot) {
            const originalBotText = replyToMessage.text; // Текст сообщения бота, на которое ответили

            // Ищем в базе, является ли исходный текст утренним приветствием
            const isActualMorningGreeting = await Greeting.findOne({ text: originalBotText });
            
            // Учитываем дефолтный текст приветствия
            const isDefaultGreeting = originalBotText === "Доброе утро, чат! 👋";

            // Если человек ответил (чем угодно!) именно на утреннее приветствие
            if (isActualMorningGreeting || isDefaultGreeting) {
                // Ищем случайный ответ в коллекции responses
                const randomResponse = await Response.aggregate([{ $sample: { size: 1 } }]);
                
                if (randomResponse[0]) {
                    let replyText = randomResponse[0].text;
                    replyText = replyText.replace('{name}', firstName);
                    
                    // Отвечаем реплаем на сообщение человека
                    await ctx.reply(replyText, { reply_to_message_id: ctx.message.message_id });
                }
            } else {
                console.log('Пользователь что-то ответил боту, но исходное сообщение не было утренним приветствием. Игнорируем.');
            }
        }

    } catch (error) {
        console.error('Ошибка в обработчике сообщений:', error);
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

// Дневной опрос по расписанию: каждый день в 15:00 по Берлину (Европе)
cron.schedule('0 15 * * *', () => {
    console.log('⏰ Сработал Крон: отправка планового дневного вопроса...');
    sendDailyQuestion();
}, {
    scheduled: true,
    timezone: "Europe/Berlin"
});

// Проверка на часовую тишину в группах: запускается каждые 10 минут
cron.schedule('*/10 * * * *', async () => {
    console.log('⏰ Крон: Проверка чатов на часовую тишину...');
    try {
        // Получаем текущий час в часовом поясе Берлина
        const berlinTime = new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" });
        const currentHour = new Date(berlinTime).getHours();

        // Ограничение: если сейчас ночь (после 22:00 или до 07:00 утра), бот спит и не спамит
        if (currentHour >= 22 || currentHour < 7) {
            console.log(`🌙 Сейчас ночное время (${currentHour}:00 по Берлину). Проверка тишины пропущена.`);
            return;
        }

        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000); // Время ровно 1 час назад

        // Ищем чаты, где никто не писал больше часа и вопрос сегодня еще не отправлялся
        const silentChats = await Chat.find({
            lastMessageAt: { $lt: oneHourAgo },
            questionSentToday: false
        });

        for (const chat of silentChats) {
            console.log(`🤫 Чат ${chat.chatId} молчит больше часа. Реанимируем...`);
            await sendDailyQuestion(chat.chatId);
        }
    } catch (error) {
        console.error('Ошибка при проверке тишины в чатах:', error);
    }
}, {
    scheduled: true,
    timezone: "Europe/Berlin"
});

// Сброс флагов отправки вопросов: каждый день в 00:01 ночи по Берлину
cron.schedule('1 0 * * *', async () => {
    console.log('⏰ Крон: Наступил новый день. Сбрасываем флаги дневных вопросов...');
    try {
        await Chat.updateMany({}, { $set: { questionSentToday: false } });
    } catch (error) {
        console.error('Ошибка сброса флагов у чатов:', error);
    }
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

// Безопасный запуск бота с перехватом ошибок инициализации
bot.launch()
    .then(() => {
        console.log('🤖 Бот успешно запущен и слушает команды!');
    })
    .catch((error) => {
        console.error('❌ Критическая ошибка при запуске бота:', error);
        // Если это временный конфликт сессий при деплое — не ломаем процесс node
        if (error.code === 409 || (error.description && error.description.includes('Conflict'))) {
            console.log('⏳ Обнаружен конфликт сессий. Ожидаем, пока Render завершит старый инстанс...');
        } else {
            process.exit(1);
        }
    });

// Глобальный перехватчик ошибок Telegraf в процессе работы (защита от краша при кривых сообщениях)
bot.catch((err, ctx) => {
    console.error(`❌ Ошибка Telegraf в процессе обработки апдейта ${ctx.update.update_id}:`, err);
});

// Плавная остановка при выключении сервера
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
