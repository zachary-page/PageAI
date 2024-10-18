const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

// Bot configuration
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMembers] });
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const MONITORED_FORUM_ID = process.env.MONITORED_FORUM_ID;
const ADMIN_REPORT_CHANNEL_ID = process.env.ADMIN_REPORT_CHANNEL_ID;
const EXCLUDED_DAYS = [6, 0];
const BUSINESS_HOURS = { start: 9, end: 17 };

// SQLite setup
const db = new sqlite3.Database('./reminders.db', (err) => {
    if (err) console.error(err.message);
    console.log('Connected to the SQLite database.');
});

// Logger
const logger = fs.createWriteStream('bot_activity.log', { flags: 'a' });

// Track messages and responses
let pendingResponses = {};

// Function to calculate delay (excluding weekends and non-business hours)
function calculateDelay(startDate, hours) {
    let delay = 0;
    let tempDate = new Date(startDate);

    while (delay < hours * 60 * 60 * 1000) {
        tempDate.setHours(tempDate.getHours() + 1);
        if (!EXCLUDED_DAYS.includes(tempDate.getDay()) &&
            tempDate.getHours() >= BUSINESS_HOURS.start &&
            tempDate.getHours() < BUSINESS_HOURS.end) {
            delay += 60 * 60 * 1000;
        }
    }
    return delay;
}

// Monitor threads and avoid duplicate timers
function monitorExistingThreads() {
    const forum = client.channels.cache.get(MONITORED_FORUM_ID);
    if (!forum) {
        console.error('Forum channel not found.');
        return;
    }

    forum.threads.fetchActive().then(threads => {
        const sortedThreads = threads.threads.sort((a, b) => b.lastMessageId - a.lastMessageId);

        sortedThreads.forEach(thread => {
            console.log(`Monitoring existing thread: ${thread.name} (ID: ${thread.id})`);

            thread.join().then(() => {
                console.log(`Joined thread: ${thread.name}`);

                thread.messages.fetch({ limit: 10 }).then(messages => {
                    messages.forEach(message => {
                        if (!message.author.bot) {
                            const userId = message.author.id;
                            const currentTime = new Date();

                            db.get(`SELECT * FROM reminders WHERE userId = ? AND threadId = ?`, [userId, thread.id], (err, row) => {
                                if (err) {
                                    console.error(`Database error:`, err);
                                    return;
                                }

                                if (!row) {
                                    // No reminder exists, create a new one
                                    const reminderHours = 24;
                                    const delay = calculateDelay(currentTime, reminderHours);

                                    if (!pendingResponses[userId]) {
                                        pendingResponses[userId] = {};
                                    }
                                    pendingResponses[userId][thread.id] = {
                                        timestamp: currentTime,
                                        reminderHours,
                                        timeout: setTimeout(() => sendReminder(userId, thread, message), delay)
                                    };

                                    db.run(`INSERT INTO reminders(userId, threadId, timestamp, reminderHours) VALUES(?, ?, ?, ?)`, [userId, thread.id, currentTime, reminderHours]);

                                    logActivity(`Started reminder for user ${userId} in thread ${thread.id}`);
                                }
                            });
                        }
                    });
                }).catch(err => {
                    console.error(`Error fetching messages from thread ${thread.id}:`, err);
                });
            }).catch(err => {
                console.error(`Error joining thread ${thread.id}:`, err);
            });
        });
    }).catch(err => {
        console.error('Error fetching active threads:', err);
    });
}

// Send reminder DM and notify the admin reporting channel
function sendReminder(userId, thread, originalMessage, isManual = false) {
    const user = client.users.cache.get(userId);
    if (user) {
        const dmMessage = `Hey, it looks like you haven't responded in the thread "${thread.name}". The other participants are still waiting for your response regarding this message: "${originalMessage.content}".`;
        user.send(dmMessage).catch(err => {
            console.error(`Error sending DM to user ${userId}:`, err);
        });

        logActivity(`Sent reminder to user ${userId} for thread ${thread.name}`);

        const adminChannel = client.channels.cache.get(ADMIN_REPORT_CHANNEL_ID);
        if (adminChannel) {
            adminChannel.send(`Reminder sent to <@${userId}> for thread "${thread.name}". ${isManual ? '(Manually Triggered)' : ''}`);
        }

        // Remove reminder after sending it if it was automatic
        if (!isManual) {
            db.run('DELETE FROM reminders WHERE userId = ? AND threadId = ?', [userId, thread.id]);
            delete pendingResponses[userId][thread.id];
        }
    }
}

// Cleaner output for `!listReminders`
function formatReminderOutput(rows) {
    return rows.map(row => {
        const user = client.users.cache.get(row.userId);
        const username = user ? user.username : `Unknown (${row.userId})`;
        const now = new Date();
        const reminderTimestamp = new Date(row.timestamp);
        const remainingTime = row.reminderHours * 60 * 60 * 1000 - (now - reminderTimestamp);
        const hours = Math.floor(remainingTime / (60 * 60 * 1000));
        const minutes = Math.floor((remainingTime % (60 * 60 * 1000)) / (60 * 1000));
        return `User: ${username}, Thread: ${row.threadId}, Time Left: ${hours}h ${minutes}m`;
    }).join('\n');
}

// Command to list reminders
client.on('messageCreate', message => {
    const BOT_REPORTING_CHANNEL_ID = '1235265391056523264';
    if (message.channel.id === BOT_REPORTING_CHANNEL_ID) {
        if (message.content.toLowerCase() === '!listreminders') {
            if (message.member.permissions.has('ADMINISTRATOR')) {
                db.all(`SELECT * FROM reminders`, (err, rows) => {
                    if (err) {
                        message.channel.send('Error retrieving reminders.');
                        return;
                    }
                    if (rows.length === 0) {
                        message.channel.send('No pending reminders.');
                    } else {
                        message.channel.send(formatReminderOutput(rows));
                    }
                });
            } else {
                message.channel.send('You do not have permission to use this command.');
            }
        }

        // Reset timers
        if (message.content.toLowerCase() === '!resetTimers') {
            if (message.member.permissions.has('ADMINISTRATOR')) {
                pendingResponses = {}; // Clear in-memory timers
                db.run('DELETE FROM reminders', (err) => {
                    if (err) {
                        message.channel.send('Error resetting timers.');
                    } else {
                        message.channel.send('All timers have been reset.');
                        monitorExistingThreads(); // Restart timers
                    }
                });
            } else {
                message.channel.send('You do not have permission to use this command.');
            }
        }
    }
});

// Restore reminders and monitor existing threads on bot start
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    monitorExistingThreads();
});

// Log the bot in
client.login(TOKEN);

// Log activity function
function logActivity(message) {
    logger.write(`${new Date().toISOString()} - ${message}\n`);
}
