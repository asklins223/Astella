import { AppUpdater } from 'electron-updater'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater'
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor'
import { prepareMacosArchiveInstall } from './macos-update-install'
import { downloadDirectThenMirrored } from './update-mirror'

/** Keep the provider, download cache and SHA-512 verification; install without ShipIt. */
export class MacosArchiveUpdater extends AppUpdater {
  private readonly archiveExecutor = new ElectronHttpExecutor((auth, callback) => this.emit('login', auth, callback))
  private archive: { path: string; version: string; sha512: string } | null = null

  constructor() { super(undefined) }

  protected async doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    const { provider, info } = options.updateInfoAndProvider
    const files = provider.resolveFiles(info)
    const zip = files.find(file => {
      const name = file.url.pathname
      return name.endsWith('.zip') && (name.includes(`-${process.arch}.zip`) || name.includes('-universal.zip'))
    })
    if (!zip) throw new Error('No ZIP update for this Mac architecture')
    return this.executeDownload({
      fileExtension: 'zip', fileInfo: zip, downloadUpdateOptions: options,
      task: (destination, downloadOptions) => downloadDirectThenMirrored(zip.url,
        target => this.archiveExecutor.download(target, destination, downloadOptions)),
      done: async event => {
        this.archive = { path: event.downloadedFile, version: event.version, sha512: zip.info.sha512 }
        this.dispatchUpdateDownloaded(event)
      },
    })
  }

  async prepareInstall(): Promise<Awaited<ReturnType<typeof prepareMacosArchiveInstall>>> {
    if (!this.archive) throw new Error('Update has not been downloaded')
    return prepareMacosArchiveInstall(this.archive)
  }

  quitAndInstall(): void {
    throw new Error('Mac updates must be staged before quitting')
  }
}
