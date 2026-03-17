import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";

import type { AppPaths, SecretsStore } from "@syncdown/core";

interface EncryptedEnvelope {
	version: 1;
	iv: string;
	tag: string;
	ciphertext: string;
}

type SecretMap = Record<string, string>;

const ENCRYPTION_ALGORITHM = "aes-256-gcm";

async function ensureMasterKey(paths: AppPaths): Promise<Buffer> {
	await mkdir(path.dirname(paths.masterKeyPath), { recursive: true });
	const masterKeyFile = Bun.file(paths.masterKeyPath);
	if (!(await masterKeyFile.exists())) {
		const key = randomBytes(32);
		await Bun.write(paths.masterKeyPath, key.toString("base64"));
		await chmod(paths.masterKeyPath, 0o600);
		return key;
	}

	const encoded = await masterKeyFile.text();
	return Buffer.from(encoded.trim(), "base64");
}

function encryptPayload(payload: SecretMap, key: Buffer): EncryptedEnvelope {
	const iv = randomBytes(12);
	const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
	const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();

	return {
		version: 1,
		iv: iv.toString("base64"),
		tag: tag.toString("base64"),
		ciphertext: ciphertext.toString("base64"),
	};
}

function decryptPayload(envelope: EncryptedEnvelope, key: Buffer): SecretMap {
	const decipher = createDecipheriv(
		ENCRYPTION_ALGORITHM,
		key,
		Buffer.from(envelope.iv, "base64"),
	);
	decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
	const plaintext = Buffer.concat([
		decipher.update(Buffer.from(envelope.ciphertext, "base64")),
		decipher.final(),
	]);

	return JSON.parse(plaintext.toString("utf8")) as SecretMap;
}

class LocalEncryptedSecretsStore implements SecretsStore {
	private async readSecrets(paths: AppPaths): Promise<SecretMap> {
		const secretsFile = Bun.file(paths.secretsPath);
		if (!(await secretsFile.exists())) {
			return {};
		}

		const key = await ensureMasterKey(paths);
		const raw = await secretsFile.text();
		const envelope = JSON.parse(raw) as EncryptedEnvelope;
		return decryptPayload(envelope, key);
	}

	private async writeSecrets(
		paths: AppPaths,
		payload: SecretMap,
	): Promise<void> {
		await mkdir(path.dirname(paths.secretsPath), { recursive: true });
		const key = await ensureMasterKey(paths);
		const envelope = encryptPayload(payload, key);
		await Bun.write(
			paths.secretsPath,
			`${JSON.stringify(envelope, null, 2)}\n`,
		);
		await chmod(paths.secretsPath, 0o600);
		await chmod(paths.masterKeyPath, 0o600);
	}

	async hasSecret(name: string, paths: AppPaths): Promise<boolean> {
		const payload = await this.readSecrets(paths);
		return typeof payload[name] === "string" && payload[name].length > 0;
	}

	async getSecret(name: string, paths: AppPaths): Promise<string | null> {
		const payload = await this.readSecrets(paths);
		return payload[name] ?? null;
	}

	async setSecret(name: string, value: string, paths: AppPaths): Promise<void> {
		const payload = await this.readSecrets(paths);
		payload[name] = value;
		await this.writeSecrets(paths, payload);
	}

	async deleteSecret(name: string, paths: AppPaths): Promise<void> {
		const payload = await this.readSecrets(paths);
		delete payload[name];
		await this.writeSecrets(paths, payload);
	}

	describe(paths: AppPaths): string {
		const status = existsSync(paths.secretsPath) ? "present" : "missing";
		const keyStatus = existsSync(paths.masterKeyPath) ? "present" : "missing";
		return `encrypted file store secrets=${status} master_key=${keyStatus} path=${paths.secretsPath}`;
	}
}

export function createSecretsStore(): SecretsStore {
	return new LocalEncryptedSecretsStore();
}
