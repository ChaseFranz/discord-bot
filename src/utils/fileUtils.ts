import { unlinkSync } from 'fs';
import { Logger } from 'winston';

export function deleteFile(filePath: string, logger: Logger) {
	try {
		unlinkSync(filePath);
		logger.info(`Deleted file: ${filePath}`);
	} catch (err) {
		logger.error(`Error deleting file ${filePath}:`, err);
	}
}
