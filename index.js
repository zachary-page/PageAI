// Import required packages
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose(); // For persistent storage
const fs = require('fs');
require('dotenv').config();  // Load environment variables from .env file


// Bot configuration
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMembers] });
const TOKEN = process.env.DISCORD_BOT_TOKEN; // Discord Bot Token
const MONITORED_FORUM_ID = process.env.MONITORED_FORUM_ID; // Forum channel ID
const ADMIN_REPORT_CHANNEL_ID = process.env.ADMIN_REPORT_CHANNEL_ID; // Admin reporting channel
const EXCLUDED_DAYS = [6, 0]; // Saturday and Sunday (0 is Sunday, 6 is Saturday)
const BUSINESS_HOURS = { start: 9, end: 17 }; // Define working hours (9am to 5pm)

// SQLite setup for persistent storage
const db = new sqlite3.Database('./reminders.db', (err) => {
    if (err) {
        console.error(err.message);
    }
    console.log('Connected to the SQLite database.');
});

// Create table for storing pending reminders and custom reminder times
db.run(`CREATE TABLE IF NOT EXISTS reminders (userId TEXT, threadId TEXT, timestamp TEXT, reminderHours INTEGER DEFAULT 24)`);

// Logger for file logging
const logger = fs.createWriteStream('bot_activity.log', { flags: 'a' });

// Track messages and responses
const pendingResponses = {};

// Function to calculate delay for reminders (excluding weekends and non-business hours)
function calculateDelay(startDate, hours) {
    let delay = 0;
    let tempDate = new Date(startDate);

    while (delay < hours * 60 * 60 * 1000) { // hours to milliseconds
        tempDate.setHours(tempDate.getHours() + 1);
        if (!EXCLUDED_DAYS.includes(tempDate.getDay()) &&
            tempDate.getHours() >= BUSINESS_HOURS.start &&
            tempDate.getHours() < BUSINESS_HOURS.end) {
            delay += 60 * 60 * 1000; // Add one hour if it's within business hours
        }
    }

    return delay;
}

// Scan and monitor existing threads in the forum, prioritizing by recent activity
function monitorExistingThreads() {
    const forum = client.channels.cache.get(MONITORED_FORUM_ID);
    if (!forum) {
        console.error('Forum channel not found.');
        return;
    }

    forum.threads.fetchActive().then(threads => {
        // Prioritize threads based on last message activity
        const sortedThreads = threads.threads.sort((a, b) => b.lastMessageId - a.lastMessageId);

        sortedThreads.forEach(thread => {
            console.log(`Monitoring existing thread: ${thread.name} (ID: ${thread.id})`);

            // Join the thread to be able to track messages
            thread.join().then(() => {
                console.log(`Joined thread: ${thread.name}`);

                // Fetch the latest messages in the thread
                thread.messages.fetch({ limit: 10 }).then(messages => {
                    messages.forEach(message => {
                        if (!message.author.bot) {
                            const userId = message.author.id;
                            const currentTime = new Date();

                            // Check if this user already has a pending reminder in this thread
                            db.get(`SELECT * FROM reminders WHERE userId = ? AND threadId = ?`, [userId, thread.id], (err, row) => {
                                if (err) {
                                    console.error(`Database error while checking reminders for user ${userId}:`, err);
                                    return;
                                }

                                if (!row) {
                                    // No reminder exists, create a new one
                                    const reminderHours = 24; // Default to 24 hours
                                    const delay = calculateDelay(currentTime, reminderHours);

                                    pendingResponses[userId] = {
                                        threadId: thread.id,
                                        timestamp: currentTime,
                                        reminderHours: reminderHours,
                                        timeout: setTimeout(() => sendReminder(userId, thread, message), delay)
                                    };

                                    // Persist the reminder in the database
                                    db.run(`INSERT INTO reminders(userId, threadId, timestamp, reminderHours) VALUES(?, ?, ?, ?)`, [userId, thread.id, currentTime, reminderHours]);

                                    logActivity(`Started reminder for user ${userId} in existing thread ${thread.id}`);
                                }
                            });
                        }
                    });
                }).catch(err => {
                    console.error(`Error fetching messages from thread ${thread.id}:`, err);
                    logActivity(`Error fetching messages from thread ${thread.id}: ${err.message}`);
                });
            }).catch(err => {
                console.error(`Error joining thread ${thread.id}:`, err);
                logActivity(`Error joining thread ${thread.id}: ${err.message}`);
            });
        });
    }).catch(err => {
        console.error('Error fetching active threads:', err);
        logActivity(`Error fetching active threads: ${err.message}`);
    });
}

// Monitor new threads created in the forum
client.on('threadCreate', thread => {
    if (thread.parentId === MONITORED_FORUM_ID && thread.type === ChannelType.PublicThread) {
        console.log(`New thread created: ${thread.name} (ID: ${thread.id})`);

        // Listen for new messages in the thread
        thread.join().then(() => {
            console.log(`Joined thread: ${thread.name}`);
        }).catch(err => {
            console.error(`Error joining new thread ${thread.id}:`, err);
            logActivity(`Error joining new thread ${thread.id}: ${err.message}`);
        });

        thread.on('messageCreate', message => {
            if (!message.author.bot) {
                const userId = message.author.id;
                const currentTime = new Date();

                // If the user has already sent a message, cancel any previous reminder
                if (pendingResponses[userId]) {
                    clearTimeout(pendingResponses[userId].timeout);
                    db.run('DELETE FROM reminders WHERE userId = ? AND threadId = ?', [userId, thread.id]);
                    delete pendingResponses[userId];
                    logActivity(`Cleared reminder for user ${userId} in thread ${thread.id}`);
                }

                // Start countdown for a new message, default is 24 hours unless custom set
                const reminderHours = 24; // Default to 24 hours
                const delay = calculateDelay(currentTime, reminderHours);

                pendingResponses[userId] = {
                    threadId: thread.id,
                    timestamp: currentTime,
                    reminderHours: reminderHours,
                    timeout: setTimeout(() => sendReminder(userId, thread, message), delay)
                };

                // Persist the reminder in the database
                db.run(`INSERT INTO reminders(userId, threadId, timestamp, reminderHours) VALUES(?, ?, ?, ?)`, [userId, thread.id, currentTime, reminderHours]);

                logActivity(`Started reminder for user ${userId} in thread ${thread.id}`);
            }
        });
    }
});

// Function to send reminder DM and notify the admin reporting channel
function sendReminder(userId, thread, originalMessage, isManual = false) {
    const user = client.users.cache.get(userId);
    if (user) {
        const dmMessage = `Hey, it looks like you haven't responded in the thread "${thread.name}". The other participants are still waiting for your response regarding this message: "${originalMessage.content}".`;
        user.send(dmMessage).catch(err => {
            console.error(`Error sending DM to user ${userId}:`, err);
            logActivity(`Error sending DM to user ${userId}: ${err.message}`);
        });

        logActivity(`Sent reminder to user ${userId} for thread ${thread.name} regarding message: ${originalMessage.content}`);

        // Send confirmation message to the admin channel
        const adminChannel = client.channels.cache.get(ADMIN_REPORT_CHANNEL_ID);
        if (adminChannel) {
            adminChannel.send(`Reminder sent to <@${userId}> for thread "${thread.name}". ${isManual ? '(Manually Triggered)' : ''}`);
        }

        // Remove the reminder after sending it if it was automatic
        if (!isManual) {
            db.run('DELETE FROM reminders WHERE userId = ? AND threadId = ?', [userId, thread.id]);
            delete pendingResponses[userId];
        }
    }
}

// Function to log activity to a file
function logActivity(message) {
    logger.write(`${new Date().toISOString()} - ${message}\n`);
}

// Restore pending reminders from the database on bot restart
function restoreReminders() {
    db.all(`SELECT * FROM reminders`, (err, rows) => {
        if (err) {
            throw err;
        }

        rows.forEach(row => {
            const userId = row.userId;
            const timestamp = new Date(row.timestamp);
            const thread = client.channels.cache.get(row.threadId); // Get the thread channel
            const delay = calculateDelay(timestamp, row.reminderHours);

            if (thread) {
                pendingResponses[userId] = {
                    threadId: row.threadId,
                    timestamp: timestamp,
                    reminderHours: row.reminderHours,
                    timeout: setTimeout(() => sendReminder(userId, thread, { content: 'Restored message' }), delay)
                };

                logActivity(`Restored reminder for user ${userId} in thread ${thread.name}`);
            }
        });
    });
}

// Restore reminders and monitor existing threads on bot start
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    restoreReminders(); // Restore any pending reminders
    monitorExistingThreads(); // Monitor existing threads when the bot starts
});

// Log the bot in
client.login(TOKEN);
