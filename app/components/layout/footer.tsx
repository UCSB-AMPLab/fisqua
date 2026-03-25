const VERSION = "0.2.0";

export function Footer() {
  return (
    <footer className="mt-20 bg-burgundy-dark px-4 py-8 text-white">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-6 sm:flex-row sm:items-start">
        <div className="max-w-xl text-sm leading-relaxed">
          <p>
            Zasqua es una plataforma de consulta de materiales de archivo
            desarrollada por{" "}
            <a
              href="https://neogranadina.org"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-white hover:text-pale-rose"
            >
              Neogranadina
            </a>{" "}
            y el{" "}
            <a
              href="https://ampl.clair.ucsb.edu"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-white hover:text-pale-rose"
            >
              Laboratorio de Archivos, Memoria y Preservación (AMPL)
            </a>{" "}
            de la Universidad de California, Santa Barbara.
          </p>
          <p className="mt-2 text-xs text-white/70">
            <a
              href={`https://github.com/neogranadina/zasqua-catalogacion/releases/tag/v${VERSION}`}
              className="text-white/70 hover:text-white"
            >
              Zasqua Catalogación v{VERSION}
            </a>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <img
            src="/logo_grande.svg"
            alt="Neogranadina"
            className="h-12 opacity-80"
          />
          <img
            src="/ampl-cropped-1.png"
            alt="AMP Lab, UC Santa Barbara"
            className="h-12 opacity-80"
          />
        </div>
      </div>
    </footer>
  );
}
