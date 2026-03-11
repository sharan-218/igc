import { redis } from "@core/queue/connection";
import chalk from "chalk";

/**
 * Main entry point to initialize the platform.
 * Bun automatically loads .env files from the root directory.
 */
async function initialize() {
  console.log(chalk.bgBlue.white.bold(" ----------------------------------------- "));
  console.log(chalk.bgBlue.white.bold(" 🚀 Web Intelligence Platform Initializing "));
  console.log(chalk.bgBlue.white.bold(" ----------------------------------------- "));
  console.log(`${chalk.dim("📍 CWD:")} ${chalk.gray(process.cwd())}`);
  
  try {
    console.log(chalk.bgCyan.black(" 📡 Testing Redis connection... "));
    const pong = await redis.ping();
    
    if (pong === "PONG") {
      console.log(chalk.bgGreen.black(" ✅ Redis: Connected successfully "));
    }

    console.log(chalk.bgBlue.white.bold(" ----------------------------------------- "));
    console.log(chalk.bgGreen.black.bold(" 🌟 Platform ready and initialized     "));
    console.log(chalk.bgBlue.white.bold(" ----------------------------------------- "));
  } catch (error) {
    console.error(chalk.bgRed.white.bold(" ❌ Initialization failed: "));
    if (error instanceof Error) {
      console.error(chalk.bgRed.white.bold(`   Message: ${error.message} `));
    } else {
      console.error(chalk.bgRed.white.bold(`   ${error} `));
    }
    process.exit(1);
  }
}

initialize();