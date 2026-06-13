import WebSocket from 'ws';
//import { Gpio } from 'onoff';
import network from 'network';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import os from 'os';
import dotenv from 'dotenv';
import { IncomingMessage, WifiSettings, NetworkInfoResponse, NetworkInterface } from './types';

dotenv.config();

/**
 * ОПРЕДЕЛЕНИЕ ПЛАТФОРМЫ
 * На Windows библиотеки для GPIO (onoff) не установятся,
 * поэтому мы используем динамический импорт.
 */
const isPi = process.platform === 'linux' && (os.arch().includes('arm') || os.arch().includes('aarch64'));

let openGatePin: any;
let closeGatePin: any;

if (isPi) {
    try {
        // Динамическое подключение только на Raspberry Pi
        const { Gpio } = require('onoff');
        openGatePin = new Gpio(27, 'out');
        closeGatePin = new Gpio(22, 'out');
        console.log('>>> СИСТЕМА: Raspberry Pi (GPIO 27, 22 готовы)');
    } catch (e) {
        console.error('>>> ОШИБКА: Не удалось загрузить onoff на Linux', e);
        setupMockPins();
    }
} else {
    console.log(`>>> СИСТЕМА: ${process.platform} (Эмуляция GPIO)`);
    setupMockPins();
}

function setupMockPins() {
    const createMock = (pin: number) => ({
        writeSync: (val: number) => console.log(`[GPIO MOCK] Пин ${pin} установлен в: ${val}`),
        unexport: () => console.log(`[GPIO MOCK] Пин ${pin} освобожден`)
    });
    openGatePin = createMock(14);
    closeGatePin = createMock(15);
}

// Установка начального состояния (низкий уровень)
openGatePin.writeSync(0);
closeGatePin.writeSync(0);

/**
 * КОНФИГУРАЦИЯ
 */
const SERVER_URL = `ws://${process.env.REMOTE_SERVER_URL}:${process.env.REMOTE_SERVER_PORT}`;
const UPDATE_URL = process.env.UPDATE_FILE_URL || 'https://spamigor.ru';
const DEST_PATH = __filename;

/**
 * ЛОГИКА WEBSOCKET
 */
function connect() {
    console.log(`Подключение к ${SERVER_URL}...`);
    const ws = new WebSocket(SERVER_URL);

    ws.on('open', () => {
        console.log('Соединение с сервером установлено.');
        // Можно отправить приветственный пакет
        ws.send(JSON.stringify({ type: 'auth', device: 'raspberry_pi' }));
    });

    ws.on('message', async (data: string) => {
        try {
            const message: IncomingMessage = JSON.parse(data);
            
            // --- ПРОВЕРКА ВРЕМЕНИ ---
            const currentTime = Date.now();
            const timeDiff = Math.abs(currentTime - message.timestamp);

            if (timeDiff > 10000) { // 10 секунд в мс
                console.warn(`Задержка сообщения: ${timeDiff}мс`);
                ws.send(JSON.stringify({ 
                    type: 'error', 
                    message: 'По какой-то причине сообщение задержалось. Прошу понять и простить' 
                }));
                return; // Прекращаем выполнение команды
            }
            // ------------------------

            switch (message.action) {
                case 'open_gate':
                    triggerPin(openGatePin, 'Открыть', ws); // передаем сокет
                    break;
                case 'close_gate':
                    triggerPin(closeGatePin, 'Закрыть', ws); // передаем сокет
                    break;
                case 'get_network_info':
                    const netInfo = await getNetworkData();
                    ws.send(JSON.stringify({ type: 'network_info', data: netInfo }));
                    break;
                case 'update_server':
                    await runAutoUpdate(ws);
                    break;
                case 'reboot_pi':
                    console.log('Получена команда на перезагрузку...');
                    const { exec } = require('child_process');
                    // Даем небольшую задержку, чтобы успеть отправить ответ серверу
                    setTimeout(() => {
                        exec('sudo reboot');
                    }, 2000);
                    ws.send(JSON.stringify({ type: 'status', message: 'Raspberry Pi уходит в перезагрузку...' }));
                    break;
            }
        } catch (e) {
            console.error('Ошибка обработки:', e);
        }
    });

    ws.on('close', () => setTimeout(connect, 5000));
    ws.on('error', (err) => console.error('WS Error:', err.message));
}

/**
 * ФУНКЦИИ УПРАВЛЕНИЯ
 */
function triggerPin(pin: any, actionName: string, ws: WebSocket) {
    pin.writeSync(1);
    console.log(`Сигнал ${actionName}: ВЫСОКИЙ (1 сек)`);
    
    // ОТПРАВЛЯЕМ ПОДТВЕРЖДЕНИЕ СЕРВЕРУ СРАЗУ
    ws.send(JSON.stringify({ 
        type: 'success', 
        message: `Команда ${actionName} получена и выполняется` 
    }));

    setTimeout(() => {
        pin.writeSync(0);
        console.log(`Сигнал ${actionName}: НИЗКИЙ`);
    }, 1000);
}

async function getNetworkData(): Promise<NetworkInfoResponse> {
    return new Promise((resolve) => {
        network.get_active_interface(async (err: Error | null, obj: NetworkInterface) => {
            let externalIp = 'unknown';
            try {
                const res = await axios.get<{ ip: string }>('https://ipify.org', { timeout: 2000 });
                externalIp = res.data.ip;
            } catch (e) {}

            // Проверяем, существует ли метод get_wifi_setting (его нет на Windows)
            if (typeof network.get_wifi_setting === 'function') {
                network.get_wifi_setting((errWifi: Error | null, wifi: WifiSettings) => {
                    resolve({
                        localIp: obj ? obj.ip_address : 'n/a',
                        externalIp,
                        ssid: wifi ? wifi.ssid : 'n/a',
                        signal: wifi ? wifi.signal : 'n/a',
                        platform: process.platform,
                        uptime: Math.round(process.uptime()) + 's'
                    });
                });
            } else {
                // Если метода нет (Windows), возвращаем данные без Wi-Fi
                resolve({
                    localIp: obj ? obj.ip_address : 'n/a',
                    externalIp,
                    ssid: 'Unsupported (Win)',
                    signal: 'n/a',
                    platform: process.platform,
                    uptime: Math.round(process.uptime()) + 's'
                });
            }
        });
    });
}

async function runAutoUpdate(ws: WebSocket) {
    ws.send(JSON.stringify({ type: 'status', message: 'Downloading update...' }));
    try {
        const response = await axios.get(UPDATE_URL);
        fs.writeFileSync(DEST_PATH, response.data);
        console.log('Файл скачан. Компиляция...');

        ws.send(JSON.stringify({ type: 'status', message: 'Building...' }));
        
        const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        
        exec(`${npmCmd} run build`, (error) => {
            if (error) {
                console.error('Ошибка сборки:', error);
                ws.send(JSON.stringify({ type: 'error', message: 'Build failed' }));
                return;
            }
            console.log('Обновление завершено. Перезагрузка процесса...');
            process.exit(0); // PM2 перезапустит сервер автоматически
        });
    } catch (err: any) {
        console.error('Ошибка обновления:', err.message);
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
}

// Запуск
connect();

// Безопасное завершение
process.on('SIGINT', () => {
    openGatePin.unexport();
    closeGatePin.unexport();
    process.exit();
});
