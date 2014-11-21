class GiftsController < ApplicationController    
  def update
    gift = Gift.find(params[:id])
    gift.update_attributes(list_params)
  end
  
  def create
    gift = Gift.create(gift_params)
    list = List.find(params[:list_id])
    list.gifts.push(gift)
    redirect_to controller: "lists", action: "show", id: params[:list_id]
  end
  
  private

  def gift_params
    params.require(:gift).permit(:name, :url, :price, :image)
  end
end