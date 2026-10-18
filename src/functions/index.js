const axios = require("axios")
const TelegramBot = require("node-telegram-bot-api")
const { app } = require('@azure/functions');
const { TableClient } = require("@azure/data-tables");
require("dotenv").config()

const greenCheck = '\u2705'; // ✅
const yellowWarning = "\u26A0\uFE0F"; // ⚠️
const redCross = '\u274C';  // ❌
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });

var storageClient = TableClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING, tableName = "khsWebsiteHealthCheckTable");
const partitionKey = "khsWebsiteHealthCheckPartitionKey"
const rowKeyCodeGreen = "codeGreenRowKey"
const rowKeyForward = "forwardRowKey"

// TelegramBot won't send to many messages in short term. That's why we collect messages and send them by less big chunks.
// Futhermore we make sure to wait a short amount of time betweens sending of messages
var telegramMessageStore = ""
var lastTelegramMessageSend = 0

async function telegramMessageSend(ctx) {
    var durationToNextSend = parseInt(lastTelegramMessageSend) + parseInt(process.env.TELEGRAM_MIN_DURATION_BETWEEN_MESSAGES) - Date.now()
    if (durationToNextSend > 0) {
        await new Promise(resolve => setTimeout(resolve, durationToNextSend)); // sleep until next send
    }

    try {
        await bot.sendMessage(process.env.TELEGRAM_GROUP_ID, telegramMessageStore, { disable_web_page_preview: true })
    } catch (error) {
        ctx.log("error sending message to telegram")
        ctx.log(error)
    }

    telegramMessageStore = ""
}

async function telegramMessage(ctx, msg) {
    if (telegramMessageStore.length != 0 && telegramMessageStore.length + msg.length + 1 > process.env.TELEGRAM_MAX_MESSAGE_SIZE) { // no space for new message
        // send collected messages
        telegramMessageSend(ctx)
    }

    if (telegramMessageStore.length == 0 && msg.length + 1 > process.env.TELEGRAM_MAX_MESSAGE_SIZE) { // message is to big for one chunk
        // message gets shortend
        telegramMessageStore = msg.substring(0, process.env.TELEGRAM_MAX_MESSAGE_SIZE - 6) + " [...]"
        telegramMessageSend(ctx)
    } else if (telegramMessageStore.length == 0) { // append message
        telegramMessageStore = msg
    } else {
        telegramMessageStore += "\n" + msg
    }
}

async function errorLog(ctx, msg, error = null) {
    ctx.log(msg)
    if (error)
        ctx.log(error)
    await telegramMessage(ctx, `${redCross} ${msg}`)
}

async function warnLog(ctx, msg) {
    ctx.log(msg)
    await telegramMessage(ctx, `${yellowWarning} ${msg}`)
}

async function msgLog(ctx, msg, telegram = false) {
    ctx.log(msg)
    if (telegram) {
        await telegramMessage(ctx, `${greenCheck} ${msg}`)
    }
}

async function initializeTable(ctx) { // Create table if not exists
    try {
        storageClient = TableClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING, tableName = "khsWebsiteHealthCheckTable");
        await storageClient.createTable();
        await ctx.log(`Table ${tableName} created or already exists.`);
    } catch (err) {
        await ctx.log(`Table creation error: ${err.message}`);
    }
}

async function updateLastCodeGreen(ctx) {
    var entity
    try {
        entity = await storageClient.getEntity(partitionKey, rowKeyCodeGreen); // read lastCodeGreen
    } catch (err) {
        await errorLog(ctx, "error updateLastCodeGreen getEntity", err.message)
        entity = { // maybe there is no entry for lastCodeGreen
            "partitionKey": partitionKey,
            "rowKey": rowKeyCodeGreen,
            lastCodeGreen: 0
        }
    }

    if (parseInt(entity.lastCodeGreen) + parseInt(process.env.TELEGRAM_CODE_GREEN_CYCLE) < Date.now()) {
        console.log(entity)
        entity.lastCodeGreen = Date.now();

        try {
            await storageClient.upsertEntity(entity, "Replace"); // write lastCodeGreen
            await ctx.log("lastCodeGreen updated successfully.");
        } catch (err) {
            await errorLog(ctx, "error updateLastCodeGreen updateEntity", err.message)
        }

        return true
    } else {
        return false
    }
}

async function axiosWithRetry(config, retries = 3, delay = 1000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await axios(config);
        } catch (error) {
            if (attempt === retries) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, delay)); // wait before retrying
        }
    }
}

async function checkWebsite(ctx, telegram = false) {
    try {
        const response = await axiosWithRetry({
            url: process.env.WEBSITE_URL,
            method: `get`,
            timeout: 20000,
        });
        const data = response.data

        if(data != null && data.includes(process.env.WEBSITE_MAGIC_STRING)) {
            await msgLog(ctx, `Website health check passed`, telegram)
        } else {
            await errorLog(ctx, `error Website health check`)
        }
    } catch (error) {
        await errorLog(ctx, `error checkWebsite fetch ${process.env.WEBSITE_URL}`, error)
    }
}

async function healthCheck(ctx) {
    const telegram = await updateLastCodeGreen(ctx)
    await initializeTable(ctx)
    await checkWebsite(ctx, telegram)

    if (telegramMessageStore.length != 0) { // only need to send if there is data
        await telegramMessageSend(ctx)
    }
}

app.timer("khs-website-health-check", {
    schedule: process.env.AZURE_CRON_TIMER,
    handler: async (myTimer, ctx) => {
        await ctx.log("beginnen health check of khs website")
        await healthCheck(ctx)
    }
})

