export interface NetworkInterface {
    name: string;
    ip_address: string;
    mac_address: string;
    type: string;
    netmask: string;
    gateway_ip: string;
}

export interface WifiSettings {
    ssid: string;
    signal: number;
    bssid: string;
    frequency: number;
}

export interface NetworkInfoResponse {
    localIp: string;
    externalIp: string;
    ssid: string;
    signal: number | string;
    platform: string;
    uptime: string;
}

export interface IncomingMessage {
    action: 'open_gate' | 'close_gate' | 'get_network_info' | 'update_server' | 'reboot_pi';
    timestamp: number; // Время отправки с сервера (Unix Timestamp в миллисекундах)
}
