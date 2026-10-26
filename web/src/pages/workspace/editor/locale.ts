import { locale } from '@@/i18n/runtime'
import { Compartment, Facet } from '@codemirror/state'

export const editorLocale = Facet.define<string, string>({ combine: values => values[0] ?? locale.value })
export const localeCompartment = new Compartment()
