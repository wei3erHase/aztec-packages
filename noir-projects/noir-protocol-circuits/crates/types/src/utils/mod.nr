// general util packages/modules are usually bad practice
// because there is no criteria for what we should not put in here.
// Reducing the size of this package would be welcome.

pub mod arrays;
pub mod field;
pub mod reader;
pub mod uint256;

// if predicate == true then return lhs, else return rhs
pub fn conditional_assign(predicate: bool, lhs: Field, rhs: Field) -> Field {
    if predicate {
        lhs
    } else {
        rhs
    }
}

pub fn arr_copy_slice<T, let N: u32, let M: u32>(
    src: [T; N],
    mut dst: [T; M],
    offset: u32,
) -> [T; M] {
    let iterator_len = if N > M { M } else { N };
    for i in 0..iterator_len {
        dst[i] = src[i + offset];
    }
    dst
}
