import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Minus, Plus, ShoppingBag, ShoppingCart, TShirt, Trash } from '@phosphor-icons/react';
import { merchApi } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthProvider';
import { useClub, useIdempotencyKey } from '../../hooks';
import { Card, PageHeader, Segmented } from '../../components/layout';
import { Alert, Badge, CardsSkeleton, EmptyState, LoadingState, QueryState } from '../../components/feedback';
import { Button, IconButton } from '../../components/Button';
import { Money } from '../../components/domain';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../utils/errorMessages';
import { formatDateTime } from '../../utils/dates';
import { sizeLabel } from '../../utils/status';
import { CART_KEY_PREFIX } from '../../auth/clientState';

// Cart lives for the tab only (sessionStorage) and holds no prices: CartPanel re-quotes on the
// server every time, and sign-out clears it (auth/clientState.js).
const cartKey = (clubId) => `${CART_KEY_PREFIX}${clubId}`;
function loadCart(clubId) {
  try {
    return JSON.parse(window.sessionStorage.getItem(cartKey(clubId))) || [];
  } catch {
    return [];
  }
}

function ProductCard({ product, onAdd, signedIn }) {
  const [size, setSize] = useState(product.variants.length === 1 ? product.variants[0].id : null);
  const variant = product.variants.find((v) => v.id === size);
  const price = product.displayPrice;
  const blocked = !price.eligible;
  return (
    <article className="card" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div className="product-art">
        <TShirt size={56} weight="duotone" aria-hidden />
      </div>
      <div className="card-body stack" style={{ flex: 1 }}>
        <div className="stack-sm" style={{ gap: 2 }}>
          <span className="subtle">{product.categoryName}</span>
          <h3>{product.name}</h3>
          <p className="subtle">{product.description}</p>
        </div>
        <div className="row" style={{ alignItems: 'baseline' }}>
          {blocked ? (
            <span className="price-now"><Money paise={product.pricePaise} /></span>
          ) : (
            <>
              <span className="price-now"><Money paise={price.finalPricePaise} /></span>
              {price.discountPaise > 0 && <span className="price-old"><Money paise={price.listPricePaise} /></span>}
            </>
          )}
        </div>
        <div className="row">
          {product.offerActive && <Badge tone="accent">Offer until {formatDateTime(product.offerEndsAt)}</Badge>}
          {price.priceRule === 'MEMBER_DISCOUNT' && <Badge tone="success">Member price</Badge>}
          {!product.availableToNonMembers && <Badge>Members only</Badge>}
          {!product.memberDiscountEligible && <Badge dot={false}>No member discount</Badge>}
        </div>
        <div className="stack-sm" style={{ marginTop: 'auto' }}>
          <span className="label" id={`size-${product.id}`}>
            Size
          </span>
          <div className="size-picker" role="group" aria-labelledby={`size-${product.id}`}>
            {product.variants.map((v) => (
              <button key={v.id} type="button" aria-pressed={size === v.id} disabled={!v.orderable} onClick={() => setSize(v.id)} aria-label={`${sizeLabel(v.sizeLabel)}${v.orderable ? `, ${v.available} left` : ', out of stock'}`}>
                {sizeLabel(v.sizeLabel)}
              </button>
            ))}
          </div>
          {variant && variant.available <= 5 && <span className="subtle" style={{ color: 'var(--color-warning)' }}>Only {variant.available} left</span>}
          {blocked && signedIn ? (
            <Alert tone="info">Available to club members only.</Alert>
          ) : (
            <Button variant="primary" icon={ShoppingCart} disabled={!variant || blocked} onClick={() => onAdd(product, variant)}>
              {variant ? 'Add to cart' : 'Choose a size'}
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

function CartPanel({ clubId, cart, setCart }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [getKey, renewKey] = useIdempotencyKey();
  const items = cart.map((c) => ({ variantId: c.variantId, quantity: c.quantity }));
  const quote = useQuery({ queryKey: ['merch-quote', clubId, items], queryFn: () => merchApi.quote(clubId, items), enabled: !!user && items.length > 0, retry: false });

  const place = useMutation({
    mutationFn: () => merchApi.placeOrder(clubId, { items, expectedTotalPaise: quote.data.totalPaise }, getKey()),
    onSuccess: (r) => {
      renewKey();
      setCart([]);
      qc.invalidateQueries({ queryKey: ['products', clubId] });
      navigate(`/checkout/${r.payment.id}`);
    },
    onError: (e) => {
      renewKey();
      if (e.code === 'PRICE_CHANGED' || e.code === 'OUT_OF_STOCK') quote.refetch();
      toast.error(e);
    },
  });

  const setQty = (variantId, q) => setCart((c) => c.map((x) => (x.variantId === variantId ? { ...x, quantity: Math.max(1, Math.min(10, q)) } : x)));
  const remove = (variantId) => setCart((c) => c.filter((x) => x.variantId !== variantId));

  return (
    <Card title="Your cart" description="Pickup at the club desk after payment." className="cart-panel">
      {!cart.length ? (
        <EmptyState icon={ShoppingBag} title="Your cart is empty">Pick a size and add items to order.</EmptyState>
      ) : (
        <div className="stack">
          <ul className="list" aria-label="Cart items">
            {cart.map((c) => {
              const line = quote.data?.lines.find((l) => l.variantId === c.variantId);
              return (
                <li key={c.variantId} style={{ paddingInline: 0 }} className="stack-sm">
                  <div className="row-between">
                    <div>
                      <div className="cell-title">{c.name}</div>
                      <div className="cell-sub">Size {sizeLabel(c.sizeLabel)}</div>
                    </div>
                    <IconButton icon={Trash} label={`Remove ${c.name} size ${c.sizeLabel}`} onClick={() => remove(c.variantId)} />
                  </div>
                  <div className="row-between">
                    <div className="row" style={{ gap: 4 }}>
                      <IconButton icon={Minus} size={16} label="Decrease quantity" onClick={() => setQty(c.variantId, c.quantity - 1)} disabled={c.quantity <= 1} />
                      <span className="num" aria-live="polite" style={{ minWidth: 24, textAlign: 'center' }}>{c.quantity}</span>
                      <IconButton icon={Plus} size={16} label="Increase quantity" onClick={() => setQty(c.variantId, c.quantity + 1)} disabled={c.quantity >= 10} />
                    </div>
                    {line ? <Money paise={line.lineTotalPaise} className="cell-title" /> : <span className="subtle">–</span>}
                  </div>
                </li>
              );
            })}
          </ul>
          {!user ? (
            <Button variant="primary" to={`/login?next=/shop/${clubId}`} block>
              Sign in to check out
            </Button>
          ) : quote.isPending ? (
            <LoadingState />
          ) : quote.isError ? (
            <Alert tone="warning" action={<Button size="sm" onClick={() => quote.refetch()}>Retry</Button>}>{errorMessage(quote.error)}</Alert>
          ) : (
            <>
              {quote.data.savingsPaise > 0 && (
                <div className="row-between subtle">
                  <span>You save</span>
                  <Money paise={quote.data.savingsPaise} />
                </div>
              )}
              <div className="row-between">
                <strong>Total</strong>
                <span className="price-now"><Money paise={quote.data.totalPaise} /></span>
              </div>
              <Button variant="primary" size="lg" block loading={place.isPending} onClick={() => place.mutate()}>
                Place order
              </Button>
              <p className="subtle">Stock is held for 15 minutes while you pay.</p>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

export default function Shop() {
  const { clubId } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const club = useClub(clubId);
  const id = club.data?.id;
  const [category, setCategory] = useState('all');
  const [cart, setCart] = useState(() => loadCart(clubId));
  const products = useQuery({ queryKey: ['products', id, !!user], queryFn: () => merchApi.products(id), enabled: !!id });

  useEffect(() => {
    try {
      window.sessionStorage.setItem(cartKey(clubId), JSON.stringify(cart));
    } catch {
      /* ignore */
    }
  }, [cart, clubId]);

  const add = (product, variant) => {
    setCart((c) => {
      const found = c.find((x) => x.variantId === variant.id);
      if (found) return c.map((x) => (x.variantId === variant.id ? { ...x, quantity: Math.min(10, x.quantity + 1) } : x));
      return [...c, { variantId: variant.id, name: product.name, sizeLabel: variant.sizeLabel, quantity: 1 }];
    });
    toast.success('Added to cart', `${product.name} · ${sizeLabel(variant.sizeLabel)}`);
  };

  const categories = [...new Set((products.data || []).map((p) => p.categoryName))];
  const count = cart.reduce((s, c) => s + c.quantity, 0);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Clubs', to: '/clubs' }, { label: club.data?.name || '…', to: club.data ? `/clubs/${club.data.slug}` : undefined }, { label: 'Shop' }]}
        title={`${club.data?.name || 'Club'} shop`}
        description="Order from your phone, pay online, collect with your pickup code."
        actions={<Badge tone="primary" dot={false}><span className="num">{count}</span>&nbsp;in cart</Badge>}
      />
      <div className="grid grid-main-side">
        <div className="stack">
          {categories.length > 1 && <Segmented label="Category" value={category} onChange={setCategory} options={[{ value: 'all', label: 'All' }, ...categories.map((c) => ({ value: c, label: c }))]} />}
          <QueryState query={products} loading={<CardsSkeleton count={4} />} empty={<div className="card"><EmptyState icon={TShirt} title="Nothing on sale right now" /></div>}>
            {(list) => (
              <div className="grid grid-2">
                {list.filter((p) => category === 'all' || p.categoryName === category).map((p) => (
                  <ProductCard key={p.id} product={p} onAdd={add} signedIn={!!user} />
                ))}
              </div>
            )}
          </QueryState>
        </div>
        <div style={{ position: 'sticky', top: 'calc(var(--header-height) + 16px)', alignSelf: 'start' }}>
          {id && <CartPanel clubId={id} cart={cart} setCart={setCart} />}
        </div>
      </div>
    </>
  );
}
