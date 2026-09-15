import { AppError } from '../utils/errors.js'

export class PluginError extends AppError {
  constructor(
    message: string,
    public readonly pluginId?: string,
    cause?: unknown,
  ) {
    super(message, 'PLUGIN_ERROR', cause)
    this.name = 'PluginError'
  }
}
