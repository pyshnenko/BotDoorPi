declare module 'network' {
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

    export function get_active_interface(callback: (err: Error | null, obj: NetworkInterface) => void): void;
    export function get_wifi_setting(callback: (err: Error | null, obj: WifiSettings) => void): void;
}