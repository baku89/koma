/**
 * The two FluidNC machines of the work, as stores built from the generic
 * factory. Import these (not defineMachineStore) from addsub code.
 */

import {defineMachineStore} from '@/stores/machine'

import {MILL_DEFINITION, RIG_DEFINITION} from '../config'

export const useMillStore = defineMachineStore(MILL_DEFINITION)
export const useRigStore = defineMachineStore(RIG_DEFINITION)
