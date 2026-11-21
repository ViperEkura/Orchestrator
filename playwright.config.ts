import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests-web', timeout: 30000, workers: 1, fullyParallel: false, reporter: 'list', use: { headless: true, viewport: {width:1440,height:940}, launchOptions: { executablePath: process.env.ORCHESTRATOR_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' } } });
