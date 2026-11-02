import "dotenv/config";

const required = (key: string): string => {
    const value = process.env[key];

    if(!value) {
        throw new Error(`Missing Environment Variable: ${key}`);
    }

    return value;
};

const env = {
    PORT: Number(process.env.PORT ?? 5000),
    MONGO_URI: required("MONGO_URI"),
    SCRAPER_TIMEOUT: Number(process.env.SCRAPER_TIMEOUT ?? 15000),
    ALLOWED_SCRAPE_HOSTS: required("ALLOWED_SCRAPE_HOSTS")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
};

export default env;
