import { AppUpdater } from 'electron-updater'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater'
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor'
import { prepareWindowsInstaller } from './windows-update-install'

/** GitHub provider, SHA-512 download and cache; no NSIS installer runtime. */
export class WindowsInstallerUpdater extends AppUpdater {
  private readonly executor = new ElectronHttpExecutor((auth, callback) => this.emit('login', auth, callback))
  private installer: { path: string; version: string; sha512: string } | null = null

  constructor() { super(undefined) }

  protected async doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    const { provider, info } = options.updateInfoAndProvider
    const file = provider.resolveFiles(info).find(file => file.url.pathname.endsWith(`-win-${process.arch}.exe`))
    if (!file) throw new Error('No Windows installer for this architecture')
    return this.executeDownload({ fileExtension: 'exe', fileInfo: file, downloadUpdateOptions: options,
      task: (destination, downloadOptions) => this.executor.download(file.url, destination, downloadOptions),
      done: async event => {
        this.installer = { path: event.downloadedFile, version: event.version, sha512: file.info.sha512 }
        this.dispatchUpdateDownloaded(event)
      },
    })
  }

  async prepareInstall(): Promise<Awaited<ReturnType<typeof prepareWindowsInstaller>>> {
    if (!this.installer) throw new Error('Update has not been downloaded')
    return prepareWindowsInstaller(this.installer)
  }

  quitAndInstall(): void { throw new Error('Windows updates must launch the independent installer before quitting') }
}
