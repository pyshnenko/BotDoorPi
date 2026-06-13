import WebSocket from 'ws';
import network from 'network';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { exec, execSync } from 'child_process';
import os from 'os';
import dotenv from 'dotenv';

dotenv.config();

/**
 * КОНФИГУРАЦИЯ
 */
const SERVER_URL = `ws://${process.env.REMOTE_SERVER_URL}:${process.env.REMOTE_SERVER_PORT}`;
const UPDATE_URL = process.env.UPDATE_FILE_URL || 'https://spamigor.ru';
const DEST_PATH = __filename;

const OPEN_PIN = 27;
const CLOSE_PIN = 22;

/**
 * ИНИЦИАЛИЗАЦИЯ GPIO (через pinctrl)
 */
function initPins() {
    try {
        // Устанавливаем пины в режим вывода (op) и низкий уровень (dl)
        execSync(`pinctrl set ${OPEN_PIN} op dl`);
        execSync(`pinctrl set ${CLOSE_PIN} op dl`);
        console.log(`>>> GPIO: Пины ${OPEN_PIN} и ${CLOSE_PIN} готовы (pinctrl)`);
    } catch (e: any) {
        console.warn('>>> GPIO Warning: pinctrl не сработал. Возможно, это Windows или старая ОС.');
    }
}

initPins();

/**
 * ЛОГИКА ПОДКЛЮЧЕНИЯ
 */
function connect() {
    console.log(`Подключение к ${SERVER_URL}...`);
    const ws = new WebSocket(SERVER_URL);

    ws.on('open', () => {
        console.log('Соединение с сервером установлено.');
        ws.send(JSON.stringify({ type: 'auth', device: 'raspberry_pi' }));
    });

    ws.on('message', async (data: string) => {
        try {
            const command = JSON.parse(data);
            console.log('Получена команда:', command.action);

            // Проверка времени (задержка > 10 сек)
            const timeDiff = Math.abs(Date.now() - (command.timestamp || 0));
            if (timeDiff > 10000) {
                ws.send(JSON.stringify({ 
                    type: 'error', 
                    message: 'По какой-то причине сообщение задержалось. Прошу понять и простить' 
                }));
                return;
            }

            switch (command.action) {
                case 'open_gate':
                    triggerPin(OPEN_PIN, 'Открыть', ws);
                    break;
                case 'close_gate':
                    triggerPin(CLOSE_PIN, 'Закрыть', ws);
                    break;
                case 'get_network_info':
                    const info = await getNetworkData();
                    ws.send(JSON.stringify({ type: 'network_info', data: info }));
                    break;
                case 'update_server':
                    await updateAndRestart(ws);
                    break;
                case 'reboot_pi':
                    ws.send(JSON.stringify({ type: 'status', message: 'Raspberry Pi уходит в ребут...' }));
                    setTimeout(() => exec('sudo reboot'), 2000);
                    break;
                default:
                    console.log('Неизвестная команда');
            }
        } catch (e) {
            console.error('Ошибка обработки сообщения:', e);
        }
    });

    ws.on('close', () => {
        console.log('Соединение закрыто. Реконнект через 5 сек...');
        setTimeout(connect, 5000);
    });

    ws.on('error', (err) => console.error('WS Error:', err.message));
}

/**
 * ФУНКЦИИ УПРАВЛЕНИЯ
 */
function triggerPin(pin: number, actionName: string, ws: WebSocket) {
    try {
        if (process.platform === 'linux') {
            execSync(`pinctrl set ${pin} dh`); // High
            setTimeout(() => execSync(`pinctrl set ${pin} dl`), 1000); // Low через 1 сек
        } else {
            console.log(`[MOCK] Пин ${pin} -> HIGH на 1 сек`);
        }

        ws.send(JSON.stringify({ 
            type: 'success', 
            message: `Команда ${actionName} выполняется` 
        }));
    } catch (e: any) {
        console.error(`Ошибка переключения пина ${pin}:`, e.message);
    }
}

async function getNetworkData(): Promise<any> {
    return new Promise((resolve) => {
        network.get_active_interface(async (err: any, obj: any) => {
            let externalIp = 'unknown';
            try {
                const res = await axios.get('https://ipify.org', { timeout: 2000 });
                externalIp = res.data.ip;
            } catch (e) {}

            const respond = (wifi: any = null) => {
                resolve({
                    localIp: obj ? obj.ip_address : 'n/a',
                    externalIp,
                    ssid: wifi ? wifi.ssid : (process.platform === 'win32' ? 'Unsupported (Win)' : 'Ethernet/None'),
                    signal: wifi ? wifi.signal : 'n/a',
                    platform: process.platform,
                    uptime: Math.round(process.uptime()) + 's'
                });
            };

            if (typeof network.get_wifi_setting === 'function') {
                network.get_wifi_setting((errW: any, wifi: any) => respond(wifi));
            } else {
                respond();
            }
        });
    });
}

async function updateAndRestart(ws: WebSocket) {
    try {
        ws.send(JSON.stringify({ type: 'status', message: 'Скачивание обновления...' }));
        const res = await axios.get(UPDATE_URL);
        fs.writeFileSync(DEST_PATH, res.data);
        ws.send(JSON.stringify({ type: 'status', message: 'Сборка...' }));
        exec('npm run build', (err) => {
            if (err) return ws.send(JSON.stringify({ type: 'error', message: 'Ошибка билда' }));
            process.exit(0); // PM2 перезапустит
        });
    } catch (e: any) {
        ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
}

connect();