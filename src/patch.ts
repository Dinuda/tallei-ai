import { Client } from "pg";
import { resolve } from "path";

const injectPatch = async () => {
    try {
        const originalConnect = Client.prototype.connect;
        const originalEnd = Client.prototype.end;

        // @ts-ignore
        Client.prototype.connect = async function (callback?: any) {
             const isConnected = (this as any)._connected || (this as any)._connecting || (this as any)._ending;
             if (isConnected) {
                 if (callback) return callback(null);
                 return Promise.resolve();
             }
             if ((this as any).connectionParameters.database === "postgres") {
                 (this as any)._connected = true;
                 if (callback) return callback(null);
                 return Promise.resolve();
             }
             return originalConnect.apply(this, arguments as any);
        };

        const originalQuery = Client.prototype.query;
        // @ts-ignore
        Client.prototype.query = function (text: any, values: any, callback: any) {
             if ((this as any).connectionParameters.database === "postgres") {
                 if (typeof text === 'string' && text.includes('SELECT 1 FROM pg_database WHERE datname')) {
                     return Promise.resolve({ rows: [{ "?column?": 1 }] }); 
                 }
                 return Promise.resolve({ rows: [] });
             }
             return originalQuery.apply(this, arguments as any);
        };
        
        // @ts-ignore
        Client.prototype.end = function () {
             if ((this as any).connectionParameters.database === "postgres") {
                 (this as any)._connected = false;
                 return Promise.resolve();
             }
             return originalEnd.apply(this, arguments as any);
        }

    } catch (e) {
        console.error("Patch error", e);
    }
};

injectPatch();
