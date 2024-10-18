# PageAI
# My Discord Reminder Bot

A Discord bot that sends reminders to users based on activity in a forum thread. It uses Discord.js and SQLite for storage.

## Setup

1. Clone the repository:
2. Install dependencies:
3. Create a `.env` file in the root directory and add your Discord bot token:
4. Run the bot: 'npm start'

## Deploying to Heroku

1. Push your code to GitHub and link your GitHub repo to Heroku.
2. Set your environment variables on Heroku (DISCORD_BOT_TOKEN).
3. Deploy the bot and start it!


## Bot Commands

### Admin Commands
Admins have access to special commands to manage reminders, manually trigger them, and view the status of all reminders.

1. **`!listReminders`**  
   - **Description**: Lists all pending reminders sorted by remaining time (from shortest to longest). 
   - **Usage**: 
     ```
     !listReminders
     ```

2. **`!removeReminder <userId> <threadId>`**  
   - **Description**: Removes a specific reminder for a user in a particular thread.
   - **Usage**: 
     ```
     !removeReminder <userId> <threadId>
     ```

3. **`!setReminderTime <threadId> <hours>`**  
   - **Description**: Sets a custom reminder time (in hours) for a specific thread.
   - **Usage**: 
     ```
     !setReminderTime <threadId> <hours>
     ```

4. **`!sendReminder <userId> <threadId>`**  
   - **Description**: Manually triggers a reminder to be sent to a user for a specific thread.
   - **Usage**: 
     ```
     !sendReminder <userId> <threadId>
     ```

5. **`!resetReminders`**  
   - **Description**: Manually resets all reminders to 24hrs.
   - **Usage**: 
     ```
     !resetReminders
     ```

### User Commands
These commands are available to all users:

1. **No user-specific commands**  
   - Users will be automatically reminded if they haven't responded in a thread after 24 hours (excluding weekends and non-business hours). 

---

### Error Logging and Reports
- **Admin Reporting Channel**: All reminders (whether manual or automatic) will be logged in the admin reporting channel with the user and thread details.


## License

MIT License
