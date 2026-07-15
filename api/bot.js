const { Telegram } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const { authenticator } = require('otplib');

// Supabase ক্লায়েন্ট তৈরি
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

// টেলিগ্রাম বট ইনিশিয়ালাইজ
const bot = new Telegram(process.env.BOT_TOKEN);

// এডমিন আইডি পার্স
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [];

// API বেস ইউআরএল
const API_BASE = 'https://api.2oo9.cloud/MXS47FLFX0U/tness/@public/api';

// --- ডাটাবেস হেল্পার ফাংশন ---

async function getSetting(key) {
    const { data, error } = await supabase.from('bot_settings').select(key).eq('id', 1).single();
    if (error) {
        console.error('সেটিংস ফেচ করতে সমস্যা:', error);
        return null;
    }
    return data ? data[key] : null;
}

async function updateSetting(key, value) {
    const { error } = await supabase.from('bot_settings').update({ [key]: value }).eq('id', 1);
    if (error) {
        console.error('সেটিংস আপডেট করতে সমস্যা:', error);
        return false;
    }
    return true;
}

async function getUser(telegram_id) {
    const { data, error } = await supabase.from('bot_users').select('*').eq('telegram_id', telegram_id).single();
    if (error && error.code !== 'PGRST116') {
        console.error('ইউজার ফেচ করতে সমস্যা:', error);
        return null;
    }
    if (!data) {
        // নতুন ইউজার তৈরি
        const { data: newUser, error: insertError } = await supabase.from('bot_users').insert({ telegram_id: telegram_id }).select().single();
        if (insertError) {
            console.error('নতুন ইউজার তৈরি করতে সমস্যা:', insertError);
            return null;
        }
        return newUser;
    }
    return data;
}

async function updateUser(telegram_id, updates) {
    const { error } = await supabase.from('bot_users').update(updates).eq('telegram_id', telegram_id);
    if (error) {
        console.error('ইউজার আপডেট করতে সমস্যা:', error);
        return false;
    }
    return true;
}

async function validateInviteCode(code) {
    const { data, error } = await supabase.from('bot_invites').select('*').eq('code', code).eq('is_active', true).single();
    if (error || !data) return null;
    if (data.current_uses >= data.max_uses) return null;
    return data;
}

async function useInviteCode(code) {
    const { data } = await supabase.from('bot_invites').select('current_uses').eq('code', code).single();
    if (data) {
        await supabase.from('bot_invites').update({ current_uses: data.current_uses + 1 }).eq('code', code);
    }
}

// --- API হেল্পার ফাংশন ---

async function fetchFromAPI(endpoint, params = {}) {
    const mauthApi = await getSetting('mauth_api');
    const url = new URL(API_BASE + endpoint);
    Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));
    
    try {
        const response = await fetch(url.toString(), {
            headers: { 'mauthapi': mauthApi }
        });
        if (!response.ok) throw new Error(`API Error: ${response.status}`);
        return await response.json();
    } catch (error) {
        console.error('API ফেচ করতে সমস্যা:', error);
        return null;
    }
}

// --- ইমেইল হেল্পার ---

async function sendFixEmail(phoneNumber) {
    const smtpUser = await getSetting('smtp_user');
    const smtpPass = await getSetting('smtp_pass');
    const targetEmail = await getSetting('target_email');

    if (!smtpUser || !smtpPass || !targetEmail) {
        console.error('SMTP কনফিগারেশন অনুপস্থিত');
        return false;
    }

    const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: { user: smtpUser, pass: smtpPass }
    });

    try {
        await transporter.sendMail({
            from: smtpUser,
            to: targetEmail,
            subject: 'Fix Request',
            text: `${phoneNumber} 1 hour and red problem fix please`
        });
        return true;
    } catch (error) {
        console.error('ইমেইল পাঠাতে সমস্যা:', error);
        return false;
    }
}

// --- কীবোর্ড জেনারেটর ---

function getMainMenu(isApproved, isAdmin) {
    const buttons = [
        [{ text: '📞 Get Number', callback_data: 'menu_getnum' }],
        [{ text: '🔢 2FA Generator', callback_data: 'menu_2fa' }]
    ];

    if (isApproved) {
        buttons.unshift([{ text: '🔧 Fix Number (VIP)', callback_data: 'menu_fixnum' }]);
    }

    buttons.push([{ text: '📊 My Stats', callback_data: 'menu_stats' }]);
    
    if (isAdmin) {
        buttons.push([{ text: '🛡️ Admin Panel', callback_data: 'menu_admin' }]);
    }

    return { reply_markup: { inline_keyboard: buttons } };
}

function getAdminPanelKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: '📈 Global Stats', callback_data: 'admin_global_stats' }],
                [{ text: '🔑 Set MAuth API Key', callback_data: 'admin_set_mauth' }],
                [{ text: '📢 Broadcast', callback_data: 'admin_broadcast' }],
                [{ text: '👥 Manage Users', callback_data: 'admin_users' }],
                [{ text: '⬅️ Back to Main Menu', callback_data: 'menu_main' }]
            ]
        }
    };
}

function getCountryInlineKeyboard(countries) {
    const keyboard = countries.map(c => ([{ text: `${c.flag} ${c.name}`, callback_data: `country_${c.id}` }]));
    keyboard.push([{ text: '⬅️ Back', callback_data: 'menu_getnum' }]);
    return { reply_markup: { inline_keyboard: keyboard } };
}

// --- সেফ এডিট মেসেজ ফাংশন (এরর হ্যান্ডলিং সহ) ---

async function safeEditMessageText(chatId, messageId, text, options = {}) {
    try {
        await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: options.parse_mode || 'Markdown',
            reply_markup: options.reply_markup || undefined
        });
        return true;
    } catch (error) {
        if (error.code === 400 && error.description && error.description.includes('message is not modified')) {
            // মেসেজ একই থাকলে এরর ইগনোর করে সফল হিসেবে ধরা হবে
            console.log('Message not modified - ignoring');
            return true;
        }
        console.error('মেসেজ এডিট করতে সমস্যা:', error);
        return false;
    }
}

async function safeDeleteMessage(chatId, messageId) {
    try {
        await bot.deleteMessage(chatId, messageId);
        return true;
    } catch (error) {
        console.error('মেসেজ ডিলিট করতে সমস্যা:', error);
        return false;
    }
}

// --- মেনু হ্যান্ডলার ---

async function handleCallback(callbackQuery) {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;
    const userId = callbackQuery.from.id;

    const user = await getUser(userId);
    if (!user) return;

    if (user.is_banned) {
        await bot.sendMessage(chatId, '❌ আপনি ব্যানড।');
        return;
    }

    // স্টেট ক্লিয়ার করার জন্য ক্যান্সেল চেক
    if (data === 'cancel_state') {
        await updateUser(userId, { current_state: null });
        await bot.sendMessage(chatId, '❌ অপারেশন বাতিল করা হয়েছে।');
        await sendMainMenu(chatId, user);
        return;
    }

    // মেইন মেনুতে ফেরত
    if (data === 'menu_main') {
        await updateUser(userId, { current_state: null });
        await sendMainMenu(chatId, user);
        return;
    }

    switch (data) {
        case 'menu_fixnum':
            if (!user.is_approved) {
                await updateUser(userId, { current_state: 'awaiting_invite_code' });
                await bot.sendMessage(chatId, '🔐 এই ফিচারটি শুধুমাত্র অনুমোদিত ব্যবহারকারীদের জন্য।\n\nঅনুগ্রহ করে আপনার সিক্রেট ইনভাইট কোড প্রদান করুন:', { reply_markup: { force_reply: true } });
            } else {
                await updateUser(userId, { current_state: 'awaiting_fix_number' });
                await bot.sendMessage(chatId, '📱 দয়া করে ফিক্স করার জন্য ফোন নম্বরটি পাঠান:', { reply_markup: { force_reply: true } });
            }
            break;

        case 'menu_getnum':
            await updateUser(userId, { current_state: null });
            await bot.sendMessage(chatId, '📞 নম্বর পাওয়ার মোড সিলেক্ট করুন:', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🌍 Auto Country Mode', callback_data: 'getnum_auto' }],
                        [{ text: '🔢 Manual Range', callback_data: 'getnum_manual' }],
                        [{ text: '📊 Live Traffic', callback_data: 'getnum_live' }],
                        [{ text: '⬅️ Back', callback_data: 'menu_main' }]
                    ]
                }
            });
            break;

        case 'menu_2fa':
            await updateUser(userId, { current_state: 'awaiting_2fa_secret' });
            await bot.sendMessage(chatId, '🔑 অনুগ্রহ করে আপনার 2FA সিক্রেট কী প্রদান করুন:', { reply_markup: { force_reply: true } });
            break;

        case 'menu_stats':
            const statsText = `📊 *আপনার পরিসংখ্যান*\n\n📞 মোট নম্বর: ${user.total_numbers}\n💬 মোট OTP: ${user.total_otps}\n✅ সফলতার হার: ${user.total_numbers > 0 ? ((user.total_otps / user.total_numbers) * 100).toFixed(2) : 0}%`;
            await bot.sendMessage(chatId, statsText, { parse_mode: 'Markdown' });
            break;

        case 'menu_admin':
            if (ADMIN_IDS.includes(userId)) {
                await bot.sendMessage(chatId, '🛡️ অ্যাডমিন প্যানেল:', getAdminPanelKeyboard());
            } else {
                await bot.answerCbQuery(callbackQuery.id, '⛔ অননুমোদিত অ্যাক্সেস।');
            }
            break;

        // --- গেট নাম্বার অপশন ---
        case 'getnum_auto':
            await bot.sendMessage(chatId, '🌍 কোন সার্ভিসের জন্য দেশ সিলেক্ট করবেন?', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📘 Facebook', callback_data: 'auto_fb' }],
                        [{ text: '💬 WhatsApp', callback_data: 'auto_wa' }],
                        [{ text: '✈️ Telegram', callback_data: 'auto_tg' }],
                        [{ text: '⬅️ Back', callback_data: 'menu_getnum' }]
                    ]
                }
            });
            break;

        case 'getnum_manual':
            await updateUser(userId, { current_state: 'awaiting_manual_range' });
            await bot.sendMessage(chatId, '🔢 দয়া করে রেঞ্জ প্রিফিক্স দিন (যেমন: 1234 বা 123X):', { reply_markup: { force_reply: true } });
            break;

        case 'getnum_live':
            await handleLiveTraffic(chatId);
            break;

        // --- অটো কান্ট্রি হ্যান্ডলার ---
        case 'auto_fb':
            await fetchAndShowTopCountries(chatId, 'Facebook');
            break;
        case 'auto_wa':
            await fetchAndShowTopCountries(chatId, 'WhatsApp');
            break;
        case 'auto_tg':
            await fetchAndShowTopCountries(chatId, 'Telegram');
            break;

        // --- অ্যাডমিন প্যানেল হ্যান্ডলার ---
        case 'admin_global_stats':
            await handleGlobalStats(chatId);
            break;
        case 'admin_set_mauth':
            await updateUser(userId, { current_state: 'awaiting_new_mauth' });
            await bot.sendMessage(chatId, '🔑 নতুন MAuth API কী প্রদান করুন:', { reply_markup: { force_reply: true } });
            break;
        case 'admin_broadcast':
            await updateUser(userId, { current_state: 'awaiting_broadcast_message' });
            await bot.sendMessage(chatId, '📢 সকল ইউজারকে যে মেসেজ পাঠাতে চান তা লিখুন:', { reply_markup: { force_reply: true } });
            break;
        case 'admin_users':
            await bot.sendMessage(chatId, '👥 ইউজার ম্যানেজমেন্ট অপশন শীঘ্রই আসছে...');
            break;

        default:
            // কান্ট্রি সিলেকশন বা OTP চেক হ্যান্ডলার
            if (data.startsWith('country_')) {
                const countryId = data.split('_').slice(1).join('_');
                await processGetNumber(chatId, userId, messageId, countryId);
            } else if (data.startsWith('getotp_')) {
                const parts = data.split('_');
                const phone = parts.slice(1, -1).join('_');
                const countryId = parts[parts.length - 1];
                await processGetOTP(chatId, userId, messageId, phone, countryId);
            } else if (data.startsWith('chk_otp_')) {
                const phone = data.replace('chk_otp_', '');
                await processGetOTP(chatId, userId, messageId, phone, 'manual');
            } else if (data.startsWith('range_')) {
                const rangeId = data.replace('range_', '');
                await processGetNumber(chatId, userId, messageId, rangeId, 'range');
            }
            break;
    }
}

// --- লাইভ ট্রাফিক হ্যান্ডলার ---

async function handleLiveTraffic(chatId) {
    const liveData = await fetchFromAPI('/liveaccess');
    const consoleData = await fetchFromAPI('/console');

    if (!liveData || !consoleData) {
        await bot.sendMessage(chatId, '❌ লাইভ ডেটা ফেচ করতে সমস্যা হয়েছে।');
        return;
    }

    const allowedServices = ['Facebook', 'WhatsApp', 'Telegram'];
    const filteredRanges = Array.isArray(liveData) ? 
        liveData.filter(item => allowedServices.some(s => item.service && item.service.includes(s))) : [];
    
    const consoleHits = {};
    if (consoleData.data && Array.isArray(consoleData.data)) {
        consoleData.data.forEach(entry => {
            const key = entry.range || entry.number;
            if (key) consoleHits[key] = (consoleHits[key] || 0) + (entry.hits || 1);
        });
    }

    const sortedRanges = filteredRanges.map(r => ({
        ...r,
        hitCount: consoleHits[r.range] || 0
    })).sort((a, b) => b.hitCount - a.hitCount).slice(0, 10);

    if (sortedRanges.length === 0) {
        await bot.sendMessage(chatId, '❌ কোন সার্ভিস রেঞ্জ পাওয়া যায়নি।');
        return;
    }

    let text = '📊 *লাইভ ট্রাফিক - সেরা রেঞ্জ*\n\n';
    const maxHits = sortedRanges[0].hitCount || 1;

    const keyboard = sortedRanges.map((range, index) => {
        let indicator = '🔴 Low';
        if (range.hitCount === maxHits) indicator = '🟢 High';
        else if (range.hitCount > maxHits / 2) indicator = '🟡 Medium';
        
        text += `${indicator} \`${range.range}\` - ${range.service || 'N/A'} (Hits: ${range.hitCount})\n`;
        return [{ text: `${indicator} ${range.range}`, callback_data: `range_${range.range}` }];
    });

    keyboard.push([{ text: '⬅️ Back', callback_data: 'menu_getnum' }]);
    
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
}

// --- টপ কান্ট্রি ফেচ ও দেখানো ---

async function fetchAndShowTopCountries(chatId, service) {
    const liveData = await fetchFromAPI('/liveaccess');
    if (!liveData || !Array.isArray(liveData)) {
        await bot.sendMessage(chatId, '❌ ডেটা ফেচ করতে সমস্যা হয়েছে।');
        return;
    }

    const serviceData = liveData.filter(item => item.service && item.service.includes(service));
    const countryCount = {};
    serviceData.forEach(item => {
        const cc = item.country_code || item.country;
        if (cc) countryCount[cc] = (countryCount[cc] || 0) + 1;
    });

    const sortedCountries = Object.entries(countryCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([code]) => {
            const sample = serviceData.find(d => d.country_code === code || d.country === code);
            return {
                id: code,
                name: sample ? (sample.country_name || code) : code,
                flag: getFlagEmoji(code)
            };
        });

    if (sortedCountries.length === 0) {
        await bot.sendMessage(chatId, '❌ এই সার্ভিসের জন্য কোন দেশ পাওয়া যায়নি।');
        return;
    }

    await bot.sendMessage(chatId, `🌍 ${service}-এর জন্য শীর্ষ দেশগুলি:`, getCountryInlineKeyboard(sortedCountries));
}

function getFlagEmoji(countryCode) {
    if (!countryCode || countryCode.length !== 2) return '🏳️';
    const codePoints = countryCode.toUpperCase().split('').map(char => 127397 + char.charCodeAt());
    return String.fromCodePoint(...codePoints);
}

// --- নম্বর প্রাপ্তি প্রক্রিয়া ---

async function processGetNumber(chatId, userId, messageId, countryId, type = 'country') {
    let apiParams = {};
    if (type === 'country') {
        apiParams.country = countryId;
    } else {
        apiParams.range = countryId;
    }
    
    const apiResponse = await fetchFromAPI('/getnum', apiParams);
    
    if (!apiResponse || !apiResponse.number) {
        await bot.sendMessage(chatId, '❌ কোন নম্বর পাওয়া যায়নি। আবার চেষ্টা করুন।');
        return;
    }

    const phoneNumber = apiResponse.number;
    const flag = type === 'country' ? getFlagEmoji(countryId) : '📱';

    await updateUser(userId, { total_numbers: (await getUser(userId)).total_numbers + 1 });

    const text = `✅ *নম্বর পাওয়া গেছে*\n\n${flag} \`${phoneNumber}\`\n\nOTP পেতে নিচের বাটনে ক্লিক করুন:`;
    
    await bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: '📩 Get OTP (Auto Fetch)', callback_data: `getotp_${phoneNumber}_${countryId}` }]]
        }
    });
}

// --- OTP প্রাপ্তি প্রক্রিয়া ---

async function processGetOTP(chatId, userId, originalMessageId, phoneNumber, countryId) {
    const processingMsg = await bot.sendMessage(chatId, '⏳ *Processing...*', { parse_mode: 'Markdown' });

    let otpFound = false;
    for (let i = 0; i < 4; i++) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        const otpResponse = await fetchFromAPI('/success-otp', { number: phoneNumber });
        if (otpResponse && otpResponse.otp) {
            otpFound = true;
            // প্রসেসিং মেসেজ ডিলিট
            await safeDeleteMessage(chatId, processingMsg.message_id);
            
            // অরিজিনাল মেসেজ আপডেট
            const flag = countryId !== 'manual' ? getFlagEmoji(countryId) : '📱';
            const newText = `✅ *নম্বর ও OTP*\n\n${flag} \`${phoneNumber}\`\n🔑 OTP: \`${otpResponse.otp}\``;
            
            // একই টেক্সট দিয়ে আবার এডিট এড়াতে আগের মেসেজ আইডি ও কন্টেন্ট চেক করুন
            await safeEditMessageText(chatId, originalMessageId, newText, { parse_mode: 'Markdown' });

            // OTP কাউন্টার আপডেট
            const user = await getUser(userId);
            await updateUser(userId, { total_otps: user.total_otps + 1 });
            break;
        }
    }

    if (!otpFound) {
        const notFoundText = `⏳ *OTP Not Received Yet.*\n📞 \`${phoneNumber}\`\n_Try checking again..._`;
        
        // প্রসেসিং মেসেজ আপডেট
        await safeEditMessageText(chatId, processingMsg.message_id, notFoundText, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '🔄 Check Again', callback_data: `chk_otp_${phoneNumber}` }]]
            }
        });
    }
}

// --- 2FA জেনারেশন ---

async function generate2FACode(chatId, secret) {
    try {
        const token = authenticator.generate(secret);
        await bot.sendMessage(chatId, `🔑 *আপনার 2FA কোড:* \`${token}\``, { parse_mode: 'Markdown' });
    } catch (error) {
        await bot.sendMessage(chatId, '❌ অবৈধ সিক্রেট কী। দয়া করে সঠিক কী প্রদান করুন।');
    }
}

// --- অ্যাডমিন ফাংশন ---

async function handleGlobalStats(chatId) {
    const { data, error } = await supabase.from('bot_users').select('total_otps');
    if (error) {
        await bot.sendMessage(chatId, '❌ পরিসংখ্যান আনতে সমস্যা হয়েছে।');
        return;
    }

    const totalOtps = data.reduce((sum, user) => sum + (user.total_otps || 0), 0);
    const estimatedRevenue = totalOtps * 0.0065;

    const text = `📈 *গ্লোবাল পরিসংখ্যান*\n\n💬 মোট OTP: ${totalOtps}\n💰 আনুমানিক রেভিনিউ: $${estimatedRevenue.toFixed(2)}`;
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

async function handleBroadcast(chatId, messageText) {
    const { data: users, error } = await supabase.from('bot_users').select('telegram_id');
    if (error) {
        await bot.sendMessage(chatId, '❌ ইউজার তালিকা আনতে সমস্যা হয়েছে।');
        return;
    }

    let successCount = 0;
    let failCount = 0;

    for (const user of users) {
        try {
            await bot.sendMessage(user.telegram_id, messageText);
            successCount++;
            await new Promise(resolve => setTimeout(resolve, 50)); // রেট লিমিটিং
        } catch (err) {
            failCount++;
            if (err.code === 403) {
                console.log(`ব্লকড ইউজার: ${user.telegram_id}`);
            }
        }
    }

    await bot.sendMessage(chatId, `✅ ব্রডকাস্ট সম্পন্ন\n📨 সফল: ${successCount}\n❌ ব্যর্থ: ${failCount}`);
}

// --- মেইন মেনু পাঠানো ---

async function sendMainMenu(chatId, user) {
    const welcomeMsg = await getSetting('welcome_msg');
    const isApproved = user.is_approved || ADMIN_IDS.includes(user.telegram_id);
    const isAdmin = ADMIN_IDS.includes(user.telegram_id);
    
    await bot.sendMessage(chatId, welcomeMsg || 'স্বাগতম!', getMainMenu(isApproved, isAdmin));
}

// --- টেক্সট মেসেজ হ্যান্ডলার ---

async function handleTextMessage(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    const user = await getUser(userId);
    if (!user || user.is_banned) return;

    if (!user.current_state) {
        await sendMainMenu(chatId, user);
        return;
    }

    switch (user.current_state) {
        case 'awaiting_invite_code':
            const invite = await validateInviteCode(text);
            if (invite) {
                await useInviteCode(text);
                await updateUser(userId, { is_approved: true, current_state: null });
                await bot.sendMessage(chatId, '✅ ইনভাইট কোড গৃহীত হয়েছে! আপনি এখন VIP ফিচার ব্যবহার করতে পারবেন।');
                await sendMainMenu(chatId, await getUser(userId));
            } else {
                await bot.sendMessage(chatId, '❌ অবৈধ বা মেয়াদ উত্তীর্ণ ইনভাইট কোড।');
            }
            break;

        case 'awaiting_fix_number':
            const phoneRegex = /^\d{10,15}$/;
            if (!phoneRegex.test(text)) {
                await bot.sendMessage(chatId, '❌ দয়া করে একটি বৈধ ফোন নম্বর প্রদান করুন।');
                return;
            }
            const emailSent = await sendFixEmail(text);
            if (emailSent) {
                await bot.sendMessage(chatId, '✅ ফিক্স রিকোয়েস্ট সফলভাবে পাঠানো হয়েছে।');
            } else {
                await bot.sendMessage(chatId, '❌ ইমেইল পাঠাতে সমস্যা হয়েছে।');
            }
            await updateUser(userId, { current_state: null });
            break;

        case 'awaiting_2fa_secret':
            await updateUser(userId, { current_state: null });
            await generate2FACode(chatId, text);
            break;

        case 'awaiting_manual_range':
            const cleanRange = text.replace(/x/gi, '');
            const apiResponse = await fetchFromAPI('/getnum', { range: cleanRange });
            
            if (!apiResponse || !apiResponse.number) {
                await bot.sendMessage(chatId, '❌ এই রেঞ্জের জন্য কোন নম্বর পাওয়া যায়নি।');
                await updateUser(userId, { current_state: null });
                return;
            }

            await updateUser(userId, { current_state: null, total_numbers: user.total_numbers + 1 });
            await bot.sendMessage(chatId, `✅ \`${apiResponse.number}\``, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '📩 Get OTP (Auto Fetch)', callback_data: `getotp_${apiResponse.number}_manual` }]]
                }
            });
            break;

        case 'awaiting_new_mauth':
            // টেস্ট রিকোয়েস্ট
            const testUrl = new URL(API_BASE + '/liveaccess');
            try {
                const testRes = await fetch(testUrl.toString(), { headers: { 'mauthapi': text } });
                if (testRes.ok) {
                    await updateSetting('mauth_api', text);
                    await bot.sendMessage(chatId, '✅ MAuth API কী সফলভাবে আপডেট হয়েছে এবং টেস্ট পাস করেছে।');
                } else {
                    await bot.sendMessage(chatId, '❌ API কী কাজ করছে না। পরিবর্তন সংরক্ষণ করা হয়নি।');
                }
            } catch (err) {
                await bot.sendMessage(chatId, '❌ টেস্ট রিকোয়েস্ট ব্যর্থ হয়েছে। কী সংরক্ষণ করা হয়নি।');
            }
            await updateUser(userId, { current_state: null });
            break;

        case 'awaiting_broadcast_message':
            await updateUser(userId, { current_state: null });
            await handleBroadcast(chatId, text);
            break;

        default:
            await updateUser(userId, { current_state: null });
            await sendMainMenu(chatId, user);
            break;
    }
}

// --- ভের্সেল সার্ভারলেস হ্যান্ডলার ---

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.status(200).send('OK');
        return;
    }

    try {
        const body = req.body;
        
        if (body.callback_query) {
            await handleCallback(body.callback_query);
        } else if (body.message && body.message.text) {
            await handleTextMessage(body.message);
        }
        
        res.status(200).json({ status: 'success' });
    } catch (error) {
        console.error('বট ইরর:', error);
        res.status(200).json({ status: 'error' }); // টেলিগ্রামকে 200 দিতেই হবে
    }
};
