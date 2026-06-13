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
 * ИНИЦИАЛИЗАЦИЯ GPIO
 */
function initPins() {
    try {
        if (process.platform === 'linux') {
            execSync(`pinctrl set ${OPEN_PIN} op dl`);
            execSync(`pinctrl set ${CLOSE_PIN} op dl`);
            console.log(`>>> GPIO: Пины ${OPEN_PIN} и ${CLOSE_PIN} готовы (pinctrl)`);
        }
    } catch (e: any) {
        console.warn('>>> GPIO Warning: pinctrl не доступен.');
    }
}

initPins();

/**
 * ЛОГИКА ПОДКЛЮЧЕНИЯ
 */
function connect() {
    console.log(`>>> WS: Попытка подключения к ${SERVER_URL}...`);
    
    const ws = new WebSocket(SERVER_URL);
    let isReconnecting = false;
    let heartbeatInterval: NodeJS.Timeout;

    const reconnect = () => {
        if (!isReconnecting) {
            isReconnecting = true;
            clearInterval(heartbeatInterval);
            console.log('>>> WS: Переподключение через 5 секунд...');
            setTimeout(() => connect(), 5000);
        }
    };

    ws.on('open', () => {
        console.log('>>> WS: Соединение с сервером установлено.');
        ws.send(JSON.stringify({ type: 'auth', device: 'raspberry_pi' }));

        // Heartbeat каждые 30 сек, чтобы соединение не разрывалось роутером
        heartbeatInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ping' }));
            }
        }, 30000);
    });

    ws.on('message', async (data: Buffer | string) => {
        try {
            const command = JSON.parse(data.toString());
            console.log('>>> Команда от сервера:', command.action);

            // Проверка задержки сообщения (10 сек)
            if (command.timestamp) {
                const timeDiff = Math.abs(Date.now() - command.timestamp);
                if (timeDiff > 10000) {
                    ws.send(JSON.stringify({ 
                        type: 'error', 
                        message: 'По какой-то причине сообщение задержалось. Прошу понять и простить' 
                    }));
                    return;
                }
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
                    console.warn('>>> Неизвестный action:', command.action);
            }
        } catch (e) {
            console.error('>>> Ошибка обработки сообщения:', e);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`>>> WS: Закрыто (код: ${code})`);
        reconnect();
    });

    ws.on('error', (err: any) => {
        console.error('>>> WS Ошибка:', err.message);
        reconnect();
    });
}

/**
 * ФУНКЦИИ УПРАВЛЕНИЯ
 */
function triggerPin(pin: number, actionName: string, ws: WebSocket) {
    try {
        if (process.platform === 'linux') {
            execSync(`pinctrl set ${pin} dh`);
            setTimeout(() => execSync(`pinctrl set ${pin} dl`), 1000);
        } else {
            console.log(`[MOCK] Пин ${pin} -> HIGH`);
        }

        // КРИТИЧНО: Отправляем успех сразу, чтобы сервер не выдал таймаут
        ws.send(JSON.stringify({ 
            type: 'success', 
            message: `Команда ${actionName} выполнена успешно` 
        }));
    } catch (e: any) {
        console.error(`Ошибка GPIO ${pin}:`, e.message);
        ws.send(JSON.stringify({ type: 'error', message: 'Ошибка железа: ' + e.message }));
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

            // Пытаемся получить данные Wi-Fi через системную команду nmcli
            let ssid = 'Ethernet/None';
            let signal = 'n/a';

            if (process.platform === 'linux') {
                try {
                    // Команда выводит: SSID:Signal
                    const wifiRaw = execSync("nmcli -t -f active,ssid,signal dev wifi | grep '^yes'").toString();
                    const parts = wifiRaw.split(':');
                    if (parts.length >= 3) {
                        ssid = parts[1];
                        signal = parts[2].trim() + '%';
                    }
                } catch (e) {
                    // Если nmcli нет или Wi-Fi выключен, останутся значения по умолчанию
                }
            }

            resolve({
                localIp: obj ? obj.ip_address : 'n/a',
                externalIp,
                ssid: ssid,
                signal: signal,
                platform: process.platform,
                uptime: Math.round(process.uptime()) + 's'
            });
        });
    });
}

async function updateAndRestart(ws: WebSocket) {
    try {
        ws.send(JSON.stringify({ type: 'status', message: 'Скачивание...' }));
        const res = await axios.get(UPDATE_URL);
        fs.writeFileSync(DEST_PATH, res.data);
        ws.send(JSON.stringify({ type: 'status', message: 'Билд...' }));
        exec('npm run build', (err) => {
            if (err) return ws.send(JSON.stringify({ type: 'error', message: 'Ошибка билда' }));
            process.exit(0);
        });
    } catch (e: any) {
        ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
}

connect();