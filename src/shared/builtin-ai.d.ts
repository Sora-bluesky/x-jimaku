export {};

declare global {
  type BuiltinTranslatorAvailability =
    | "unavailable"
    | "downloadable"
    | "downloading"
    | "available";

  interface TranslatorOptions {
    sourceLanguage: string;
    targetLanguage: string;
  }

  interface TranslatorInstance {
    translate(input: string): Promise<string>;
  }

  interface TranslatorFactory {
    availability(
      options: TranslatorOptions,
    ): Promise<BuiltinTranslatorAvailability>;

    create(
      options: TranslatorOptions,
    ): Promise<TranslatorInstance>;
  }

  var Translator: TranslatorFactory;
}
