import {deepCopy, diffArray, partition} from "../util/helpers";
import {ContentEdit} from "../data/content_edit";
import {Latch} from "./state_handler";
import {__getProxyTarget} from "./readonly";

export interface UpdateLike<S> {
    // Sentinel field so we can distinguish an update from a value
    isStateUpdate: true

    // Apply the update to the given value, mutating in-place if possible. Return the updated value, and indicate using
    // the given latch whether a change was made.
    applyMutate(value: S): UpdateResult<S>
}


// Partial<V[]> confuses TypeScript – TS thinks it has iterators and array methods and such.
// This is to avoid that.
export type Partial1<S> = S extends (infer V)[] ? Record<number, V> : Partial<S>;

// Types for expressing a mapping of keys to update results for those keys' values
export type ObjectFieldUpdates<S> = {
    [K in keyof S]?: UpdateResult<S[K]>;
}

export type FieldUpdates<S> = S extends (infer V)[] ? Record<number, UpdateResult<V>> : ObjectFieldUpdates<S>;

export interface UpdateResult<S> {
    update: UpdateLike<S>
    newValue: S

    // if S is a primitive, the previous value.
    oldValue?: S

    // A dict of values that this update removed from an object (if applicable)
    removedValues?: Partial1<S>

    // A dict of values that this update added to the object (if applicable)
    addedValues?: Partial1<S>

    // A dict of child updates to fields of this object
    fieldUpdates?: FieldUpdates<S>
}

export const UpdateResult = Object.freeze({
    addedOrChangedKeys<S>(result: UpdateResult<S>): (keyof S)[] {
        const updated: (keyof S)[] = [];
        if (!result.fieldUpdates)
            return updated;
        if (!result.removedValues)
            return Object.keys(result.fieldUpdates) as (keyof S)[];

        for (const prop in result.fieldUpdates) {
            if (result.fieldUpdates.hasOwnProperty(prop) && !(prop in result.removedValues))
                updated.push(prop as any as keyof S)
        }
        return updated;
    },

    addedOrChangedValues<V, S extends Record<any, V> | V[]>(result: UpdateResult<S>): Partial1<S> {
        const updated: Partial1<S> = {} as Partial1<S>;
        if (!result.fieldUpdates)
            return updated;

        for (const prop in result.fieldUpdates) {
            if (result.fieldUpdates.hasOwnProperty(prop) && !((result.fieldUpdates as any)[prop].update instanceof Destroy)) {
                (updated as any)[prop] = ((result.fieldUpdates as any)[prop] as V)
            }
        }
        return updated;
    }
})

export type StateUpdate<S> = UpdateLike<S>;

export abstract class Update<S> implements UpdateLike<S> {
    readonly isStateUpdate: true = true

    abstract applyMutate(value: S): UpdateResult<S>
}

export const NoUpdate = Object.freeze({
    isStateUpdate: true,
    applyMutate(prev: any): UpdateResult<any> { return { update: NoUpdate, newValue: prev } }
}) as UpdateLike<any>;

function noChange<S>(value: S): UpdateResult<S> {
    return { update: NoUpdate, newValue: value }
}

function destroyed<S>(value: S): UpdateResult<S> {
    return { update: Destroy.Instance, newValue: undefined as any as S, oldValue: value, fieldUpdates: AllDestroyedUpdates as FieldUpdates<S> }
}

function setTo<S>(value: S, oldValue?: S): UpdateResult<S> {
    if (oldValue === value)
        return { update: NoUpdate, newValue: value };
    return { update: setValue(value), newValue: value, oldValue };
}

export function childResult<S, K extends keyof S, V extends S[K] = S[K]>(result: UpdateResult<S>, key: K): UpdateResult<V> {
    return ((result.fieldUpdates as ObjectFieldUpdates<S>)?.[key] ?? setTo(result.newValue[key])) as UpdateResult<V>
}

const AllDestroyedUpdates: FieldUpdates<any> = new Proxy({}, {
    get(target: {}, p: PropertyKey, receiver: any): UpdateResult<any> {
        return {
            update: Destroy.Instance,
            newValue: undefined,
            fieldUpdates: AllDestroyedUpdates
        }
    }
})

/**
 * A proxy which lazily answers questions about field updates in an array.
 * This is to avoid eagerly filling up a structure with updates, when they might not even be accessed.
 * @param arr        The (mutated) array
 * @param minIdx     The first index affected by the change
 * @param maxIdx     The last index affected by the change
 * @param indexShift By how much the values in the array between those two indices shifted.
 */
function arrayFieldUpdates<V>(arr: V[], minIdx: number, maxIdx: number, indexShift: number): FieldUpdates<V[]> {
    const dict: Record<number, UpdateResult<V>> = {};
    let enumerated: number[] | undefined = undefined;
    const enumerate = (target: Record<number, UpdateResult<V>>): number[] => {
        if (enumerated === undefined) {
            enumerated = [];
            for (let i = minIdx; i <= maxIdx; i++) {
                enumerated.push(i);
            }
        }
        return enumerated;
    }
    return new Proxy(dict, {
        get(target: Record<number, UpdateResult<V>>, idx: number, receiver: any): UpdateResult<V> {
            if (idx >= minIdx && idx <= maxIdx) {
                if (!target[idx]) {
                    const oldValue = arr[idx - indexShift];
                    const newValue = arr[idx];
                    target[idx] = {
                        update: setValue(newValue),
                        newValue,
                        oldValue
                    }
                }
                return target[idx];
            }
            return noChange(arr[idx]);
        },
        has(target: Record<number, UpdateResult<V>>, idx: number): boolean {
            return idx >= minIdx && idx <= maxIdx;
        },
        enumerate: enumerate,
        ownKeys: enumerate
    })
}

export class RemoveKey<S, K extends keyof S> extends Update<S> {
    constructor(readonly key: K, private _value?: S[K]) { super() }

    static unapply<S, K extends keyof S>(inst: RemoveKey<S, K>): ConstructorParameters<typeof RemoveKey> {
        return [inst.key, inst.value]
    }

    get value(): S[K] | undefined { return this._value }

    applyMutate(value: S): UpdateResult<S> {
        if (value === null || value === undefined || !(this.key in value))
            return noChange(value);
        const oldValue: S[K] = value[this.key];
        delete value[this.key];
        return {
            update: this,
            newValue: value,
            removedValues: {
                [this.key]: oldValue
            } as Partial1<S>,
            fieldUpdates: {
                [this.key]: destroyed(oldValue)
            } as FieldUpdates<S>
        };
    }
}

export class UpdateKey<S, K extends keyof S> extends Update<S> {
    constructor(readonly key: K, private _update: UpdateLike<S[K]>) { super() }

    get update(): UpdateLike<S[K]> { return this._update; }

    applyMutate(value: S): UpdateResult<S> {
        const childResult: UpdateResult<S[K]> = this._update.applyMutate(value[this.key]);
        if (childResult.update === NoUpdate)
            return noChange(value);

        value[this.key] = childResult.newValue;
        return {
            update: this,
            newValue: value,
            fieldUpdates: {
                [this.key]: childResult
            } as FieldUpdates<S>
        };
    }

}

export class RemoveValue<V> extends Update<V[]> {
    constructor(readonly value: V, private _index: number) { super() }

    static unapply<V>(inst: RemoveValue<V>): ConstructorParameters<typeof RemoveValue> {
        return [inst.value, inst.index];
    }

    get index(): number { return this._index; }

    applyMutate(arr: V[]): UpdateResult<V[]> {
        const idx = this._index;
        const len = arr.length;
        if (arr[idx] !== this.value) {
            throw new Error("RemoveValue is no longer valid as array has changed");
        }

        arr.splice(idx, 1);

        return {
            update: this,
            newValue: arr,
            removedValues: {
                [this.index]: this.value
            },
            get fieldUpdates() {
                return arrayFieldUpdates(arr, idx, len, -1)
            }
        };
    }
}

export class InsertValue<V> extends Update<V[]> {
    constructor(readonly value: V, private _targetIndex?: number) { super() }

    static unapply<V>(inst: InsertValue<V>): ConstructorParameters<typeof InsertValue> {
        return [inst.value, inst.targetIndex]
    }

    get targetIndex(): number { return this._targetIndex! }

    applyMutate(arr: V[]): UpdateResult<V[]> {
        if (arr === undefined) {
            arr = [];
        }

        const targetIndex = this.targetIndex ?? arr.length;
        if (this._targetIndex) {
            arr.splice(this.targetIndex, 0, this.value);
        } else {
            this._targetIndex = arr.length;
            arr.push(this.value);
        }

        return {
            update: this,
            newValue: arr,
            addedValues: {
                [targetIndex]: this.value
            },
            get fieldUpdates() {
                return arrayFieldUpdates(arr, targetIndex, arr.length, 1)
            }
        };
    }
}

export class MoveArrayValue<V> extends Update<V[]> {
    constructor(readonly fromIndex: number, readonly toIndex: number) { super(); }

    static unapply<V>(inst: MoveArrayValue<V>): ConstructorParameters<typeof MoveArrayValue> {
        return [inst.fromIndex, inst.toIndex]
    }

    applyMutate(arr: V[]): UpdateResult<V[]> {
        const minIdx = Math.min(this.fromIndex, this.toIndex);
        const maxIdx = Math.max(this.fromIndex, this.toIndex);
        const elem = arr.splice(this.fromIndex, 1)[0];
        arr.splice(this.toIndex, 0, elem);
        return {
            update: this,
            newValue: arr,
            get fieldUpdates() {
                return arrayFieldUpdates(arr, minIdx, maxIdx, 1)
            }
        };
    }

}

export class RenameKey<S, K0 extends keyof S, K1 extends keyof S, V extends S[K0] & S[K1]> extends Update<S> {
    constructor(readonly oldKey: K0, readonly newKey: K1) { super() }

    static unapply<S, K0 extends keyof S, K1 extends keyof S, V extends S[K0] & S[K1]>(inst: RenameKey<S, K0, K1, V>): ConstructorParameters<typeof RenameKey> {
        return [inst.oldKey, inst.newKey];
    }

    applyMutate(obj: S): UpdateResult<S> {
        const value: V = obj[this.oldKey] as V;
        obj[this.newKey] = value;
        delete obj[this.oldKey];
        return {
            update: this,
            newValue: obj,
            removedValues: {
                [this.oldKey]: value
            } as Partial1<S>,
            addedValues: {
                [this.newKey]: value
            } as Partial1<S>,
            fieldUpdates: {
                [this.oldKey]: destroyed(value),
                [this.newKey]: setTo(value)
            } as FieldUpdates<S>
        };
    }
}

export class Destroy<S> extends Update<S | undefined> {
    constructor() { super() }
    static Instance: Destroy<any> = new Destroy();

    static unapply<S>(inst: Destroy<S>): ConstructorParameters<typeof Destroy> {
        return []
    }

    applyMutate(value: S | undefined): UpdateResult<S | undefined> {
        return {
            update: Destroy.Instance,
            newValue: undefined,
            oldValue: value,
            fieldUpdates: AllDestroyedUpdates as FieldUpdates<S>
        }
    }
}

type PartialKeySet<S> = {
    [K in keyof S]?: true
}

function objectDiffUpdates<S extends object>(update: UpdateLike<S>, oldObj: S, newObj: S): UpdateResult<S> {
    // if we set the value of an object state, find the keys that changed
    // this is done lazily, because the diff might not be used.

    let removedValues: Partial<S> | undefined = undefined;
    let addedValues: Partial<S> | undefined = undefined;
    let fieldUpdates: ObjectFieldUpdates<S> | undefined = undefined;

    function compute() {
        removedValues = {};
        addedValues = {};

        if (!oldObj)
            oldObj = {} as any as S;

        if (!newObj)
            newObj = {} as any as S;

        const updatedKeys: PartialKeySet<S> = {};

        for (const oldKey in oldObj) {
            if (oldObj.hasOwnProperty(oldKey)) {
                if (!newObj.hasOwnProperty(oldKey)) {
                    removedValues[oldKey] = oldObj[oldKey];
                    updatedKeys[oldKey] = true;
                } else if (oldObj[oldKey] !== newObj[oldKey]) {
                    updatedKeys[oldKey] = true;
                }
            }
        }

        for (const newKey in newObj) {
            if (newObj.hasOwnProperty(newKey)) {
                if (!oldObj.hasOwnProperty(newKey)) {
                    addedValues[newKey] = newObj[newKey];
                    updatedKeys[newKey] = true;
                } else if (oldObj[newKey] !== newObj[newKey]) {
                    updatedKeys[newKey] = true;
                }
            }
        }

        fieldUpdates = new Proxy({} as ObjectFieldUpdates<S>, {
            enumerate(target: ObjectFieldUpdates<S>): PropertyKey[] {
                return Object.keys(updatedKeys);
            },
            ownKeys(target: ObjectFieldUpdates<S>): PropertyKey[] {
                return Object.keys(updatedKeys);
            },
            has(target: ObjectFieldUpdates<S>, p: PropertyKey): boolean {
                return p in updatedKeys
            },
            get<P extends keyof S>(target: ObjectFieldUpdates<S>, p: P, receiver: any): UpdateResult<S[P]> {
                if (p in updatedKeys && !target[p]) {
                    if (p in removedValues!) {
                        target[p] = destroyed(oldObj[p]) as UpdateResult<S[P]>
                    } else if (typeof newObj[p] === 'object' || typeof oldObj[p] === 'object') {
                        // @ts-ignore – it can't handle the "extends object" of objectDiffUpdates
                        target[p] = objectDiffUpdates(setValue(newObj[p]), oldObj[p], newObj[p])
                    } else {
                        target[p] = {
                            update: setValue(newObj[p]),
                            newValue: newObj[p],
                            oldValue: oldObj[p]
                        }
                    }
                }
                return target[p]!;
            }
        })
    }

    return {
        update,
        newValue: newObj,
        get removedValues() {
            if (!removedValues)
                compute();
            return removedValues as Partial1<S>
        },
        get addedValues() {
            if (!addedValues)
                compute();
            return addedValues as Partial1<S>
        }
    }

}

export class SetValue<S> extends Update<S> {
    constructor(readonly value: S) {
        super()
    }

    // TODO: Extractable seems to be problematic on parametric data classes when primitive types are involved.
    static unapply<T>(inst: SetValue<T>): ConstructorParameters<typeof SetValue> { return [inst.value] }

    applyMutate(oldValue: S): UpdateResult<S> {
        if (oldValue === this.value) {
            return noChange(oldValue);
        } else if (typeof oldValue === 'object' || typeof this.value === 'object') {
            // @ts-ignore – it can't realize that S must extend object
            return objectDiffUpdates<S>(this, oldValue, this.value);
        } else return {
            update: this,
            newValue: this.value,
            oldValue: oldValue
        }
    }
}

export class EditString extends Update<string> {
    constructor(readonly edits: ContentEdit[]) {
        super();
    }

    static unapply(inst: EditString): ConstructorParameters<typeof EditString> { return [inst.edits] }

    applyMutate(value: string): UpdateResult<string> {
        if (this.edits.length === 0) {
            return noChange(value);
        }

        let result = value;
        for (let i = 0; i < this.edits.length; i++) {
            result = this.edits[i].apply(result);
        }
        return {
            update: this,
            newValue: result,
            oldValue: value
        };
    }
}


export type UpdatePartial<T> = {
    [P in keyof T]?: UpdateOf<T[P]>
}

export type UpdateOf<T> = T | UpdateLike<T> | UpdatePartial<T>

export function isUpdateLike(value: any): value is UpdateLike<any> {
    return value && value.isStateUpdate
}

function isUpdatePartial<S>(value: UpdateOf<S>): value is UpdatePartial<S> {
    return value && typeof value === 'object' && !(value as any).isStateUpdate && (value as any).constructor === Object
}

class UpdateWith<S> extends Update<S> {
    constructor(readonly fieldUpdates: UpdateOf<S>, private _removedValues: Partial<S> = {}) {
        super()
    }

    applyMutate(oldValue: S): UpdateResult<S> {
        let fieldUpdateResults: ObjectFieldUpdates<S> | undefined = undefined;
        let addedValues: Partial<S> | undefined = undefined;
        let removedValues: Partial<S> | undefined = undefined;
        let anyChanged: boolean = false;
        const value: any = oldValue || {};

        const updates = this.fieldUpdates as any;
        if (typeof updates === 'object') {
            for (const prop in updates) {
                if (updates.hasOwnProperty(prop)) {
                    const key = prop as keyof S;
                    const update = (updates as any)[key];
                    const updateResult = update.applyMutate(value[key]);

                    fieldUpdateResults = fieldUpdateResults || {};
                    fieldUpdateResults[key] = updateResult;

                    if (updateResult.update !== NoUpdate) {
                        anyChanged = true;
                    }

                    if (updateResult.update instanceof Destroy) {
                        removedValues = removedValues || {};
                        removedValues[key] = updateResult.oldValue;
                    }

                    if (!value.hasOwnProperty(key)) {
                        addedValues = addedValues || {};
                        addedValues[key] = updateResult.newValue;
                    }
                    value[key] = updateResult.newValue;
                }
            }
            if (anyChanged) {
                return {
                    update: this,
                    newValue: value,
                    addedValues: addedValues as Partial1<S>,
                    removedValues: removedValues as Partial1<S>,
                    fieldUpdates: fieldUpdateResults as FieldUpdates<S>
                };
            } else {
                return noChange(value);
            }
        } else if (oldValue === updates) {
            return noChange(oldValue)
        } else {
            return {
                update: setValue(updates as S),
                newValue: updates as S,
                oldValue
            }
        }
    }

}

/**
 * If the given update value is not already an update, return the update that it specifies.
 * If the update is a direct value, wrap it in SetValue. If the update is an object specifying updates to keys,
 * recursively transform the object's values to be Updates as well.
 */
export function valueToUpdate<S>(updates: UpdateOf<S>): StateUpdate<S> {
    if (isUpdateLike(updates)) {
        return updates;
    } else if (isUpdatePartial<S>(updates)) {
        const updates1 = updates as any;
        const onlyUpdates: UpdateOf<S> = {};
        for (const prop in updates1) {
            if (updates1.hasOwnProperty(prop)) {
                const key = prop as keyof S;
                onlyUpdates[key] = valueToUpdate((updates as UpdatePartial<S>)[key]);
                if (onlyUpdates[key] === NoUpdate) {
                    delete onlyUpdates[key]
                }
            }
        }
        return new UpdateWith(onlyUpdates);
    } else {
        return setValue(updates as S)
    }
}

/**
 * Constructors for state updates
 */
export function removeKey<S, K extends keyof S>(key: K): StateUpdate<S> {
    return new RemoveKey<S, K>(key);
}

export function renameKey<S, K0 extends keyof S, K1 extends keyof S, V extends S[K0] & S[K1]>(oldKey: K0, newKey: K1): StateUpdate<S> {
    return new RenameKey<S, K0, K1, V>(oldKey, newKey);
}

export function setValue<V, V1 extends V = V>(value: V1, oldValue?: V1): StateUpdate<V> {
    return new SetValue(__getProxyTarget(value as V))
}

export const setUndefined: StateUpdate<any> = new SetValue(undefined);

export const setToUndefined: UpdateResult<any> = Object.freeze({
    update: setUndefined,
    newValue: undefined
});

export function setProperty<S, K extends keyof S, V extends S[K] = S[K]>(key: K, value: V): StateUpdate<S> {
    return new UpdateKey<S, K>(key, new SetValue<S[K]>(value))
}

export function updateProperty<S, K extends keyof S>(key: K, update: UpdateOf<S[K]>): StateUpdate<S> {
    return new UpdateKey<S, K>(key, valueToUpdate(update));
}

export function destroy<V>(): StateUpdate<V> {
    return Destroy.Instance as any as StateUpdate<V>
}

export function append<V, V1 extends V = V>(value: V1): StateUpdate<V[]> {
    return new InsertValue(value) as StateUpdate<V[]>
}

export function insert<V, V1 extends V = V>(value: V1, index: number): StateUpdate<V[]> {
    return new InsertValue<V>(value, index)
}

export function clearArray<V>(): StateUpdate<V[]> {
    // TODO: should this be its own op?
    return new SetValue<V[]>([])
}

export function moveArrayValue<V>(fromIndex: number, toIndex: number): StateUpdate<V[]> {
    return new MoveArrayValue(fromIndex, toIndex)
}

export function editString(edits: ContentEdit[]): StateUpdate<string> {
    return new EditString(edits)
}

export function removeFromArray<V>(arr: Readonly<V[]>, value: V, compare?: (a: V, b: V) => boolean): StateUpdate<V[]> {
    value = __getProxyTarget(value);
    arr = __getProxyTarget(arr);
    const idx = compare ? arr.findIndex(v => compare(v, value)) : arr.indexOf(value);
    if (idx >= 0) {
        return new RemoveValue(value, idx);
    }
    return NoUpdate;
}

export function removeIndex<V>(arr: Readonly<V[]>, index: number): StateUpdate<V[]> {
    arr = __getProxyTarget(arr);
    if (arr.hasOwnProperty(index)) {
        return new RemoveValue(arr[index], index)
    }
    return NoUpdate
}

export function noUpdate<S>(): StateUpdate<S> {
    return NoUpdate;
}